import fs from "node:fs";
import path from "node:path";
import {
    AppBskyEmbedImages,
    AppBskyEmbedVideo,
    type AppBskyFeedPost,
    type BlobRef,
} from "@atproto/api";

// ── Flags ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const filtered = args.filter((a) => a !== "--dry-run");

// ── MIME helpers ────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
};

function mimeFor(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_MAP[ext];
    if (!mime) {
        console.error(`Unsupported file type: ${ext}`);
        console.error(`Supported: ${Object.keys(MIME_MAP).join(", ")}`);
        process.exit(1);
    }
    return mime;
}

function isVideo(mime: string): boolean {
    return mime.startsWith("video/");
}

// ── Video upload (recommended flow via video.bsky.app) ─────────
// Note: agent is passed as a parameter since it's lazy-loaded

async function uploadVideo(filePath: string, mime: string): Promise<BlobRef> {
    const { agent } = await import("./agent.ts");
    const fileBytes = fs.readFileSync(filePath);

    // 1. Get service auth token scoped for upload
    const pdsHost = agent.pdsUrl?.hostname ?? "bsky.social";
    const serviceAuth = await agent.com.atproto.server.getServiceAuth({
        aud: `did:web:${pdsHost}`,
        lxm: "com.atproto.repo.uploadBlob",
        exp: Math.floor(Date.now() / 1000) + 60 * 30, // 30 min
    });

    // 2. Upload video to the video service
    const uploadUrl = new URL(
        "https://video.bsky.app/xrpc/app.bsky.video.uploadVideo"
    );
    uploadUrl.searchParams.set("did", agent.session!.did);
    uploadUrl.searchParams.set("name", path.basename(filePath));

    const uploadRes = await fetch(uploadUrl.toString(), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${serviceAuth.data.token}`,
            "Content-Type": mime,
        },
        body: fileBytes,
    });

    if (!uploadRes.ok) {
        throw new Error(`Video upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
    }

    const uploadData = (await uploadRes.json()) as { jobId: string };
    console.log(`Video uploaded, processing (job: ${uploadData.jobId})...`);

    // 3. Poll job status until complete
    let blob: BlobRef | undefined;
    for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));

        const statusRes = await agent.app.bsky.video.getJobStatus({
            jobId: uploadData.jobId,
        });
        const job = statusRes.data.jobStatus;

        if (job.state === "JOB_STATE_COMPLETED" && job.blob) {
            blob = job.blob;
            break;
        }
        if (job.state === "JOB_STATE_FAILED") {
            throw new Error(`Video processing failed: ${job.error ?? "unknown error"}`);
        }

        // Still processing — show progress
        if (i % 5 === 0) {
            console.log(`  still processing... (${job.state})`);
        }
    }

    if (!blob) {
        throw new Error("Video processing timed out after 4 minutes");
    }

    console.log("Video processing complete.");
    return blob;
}

// ── Image upload ───────────────────────────────────────────────

async function uploadImage(
    filePath: string,
    mime: string
): Promise<BlobRef> {
    const { agent } = await import("./agent.ts");
    const fileBytes = fs.readFileSync(filePath);
    const response = await agent.uploadBlob(fileBytes, { encoding: mime });
    return response.data.blob;
}

// ── Main ───────────────────────────────────────────────────────

const text = filtered[0];
if (!text) {
    console.error("Usage: npx tsx scripts/post.ts <TEXT> [MEDIA_PATH...] [--dry-run]");
    console.error('Example: npx tsx scripts/post.ts "Hello Bluesky!" photo.jpg video.mp4');
    console.error("        npx tsx scripts/post.ts \"Test\" photo.jpg --dry-run");
    process.exit(1);
}

const mediaPaths = filtered.slice(1);

// Build the post record
const record: Partial<AppBskyFeedPost.Record> = {
    text,
    createdAt: new Date().toISOString(),
};

const imageFiles: string[] = [];
let videoFile: string | undefined;

for (const mp of mediaPaths) {
    if (!fs.existsSync(mp)) {
        console.error(`File not found: ${mp}`);
        process.exit(1);
    }
    const mime = mimeFor(mp);
    if (isVideo(mime)) {
        if (videoFile) {
            console.error("Error: only one video per post is allowed on Bluesky.");
            process.exit(1);
        }
        videoFile = mp;
    } else {
        imageFiles.push(mp);
    }
}

// Cannot mix images and video in one post
if (videoFile && imageFiles.length > 0) {
    console.error("Error: cannot mix images and video in a single Bluesky post.");
    process.exit(1);
}

if (imageFiles.length > 4) {
    console.error("Error: Bluesky allows a maximum of 4 images per post.");
    process.exit(1);
}

// ── Dry-run mode ────────────────────────────────────────────────

if (dryRun) {
    console.log("[DRY RUN] Would post the following:");
    console.log(`  Text: ${text}`);
    if (videoFile) {
        const stat = fs.statSync(videoFile);
        console.log(`  Video: ${path.basename(videoFile)} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${mimeFor(videoFile)})`);
    }
    for (const img of imageFiles) {
        const stat = fs.statSync(img);
        console.log(`  Image: ${path.basename(img)} (${(stat.size / 1024).toFixed(0)} KB, ${mimeFor(img)})`);
    }
    if (!videoFile && imageFiles.length === 0) {
        console.log("  Media: none");
    }
    console.log("[DRY RUN] No API calls made. Remove --dry-run to post.");
    process.exit(0);
}

// ── Lazy-load agent only when actually posting ──────────────────

const { agent } = await import("./agent.ts");

// ── Upload and post ─────────────────────────────────────────────

if (mediaPaths.length > 0) {
    if (videoFile) {
        const mime = mimeFor(videoFile);
        const blob = await uploadVideo(videoFile, mime);
        record.embed = {
            $type: "app.bsky.embed.video",
            video: blob,
            alt: "",
        } satisfies AppBskyEmbedVideo.Main;
        console.log("Video embed ready.");
    } else {
        const images: AppBskyEmbedImages.Image[] = [];
        for (const img of imageFiles) {
            const mime = mimeFor(img);
            const blob = await uploadImage(img, mime);
            images.push({ image: blob, alt: "" });
            console.log(`Uploaded image: ${path.basename(img)}`);
        }
        record.embed = {
            $type: "app.bsky.embed.images",
            images,
        } satisfies AppBskyEmbedImages.Main;
        console.log(`${images.length} image(s) embedded.`);
    }
}

try {
    const res = await agent.post(record as AppBskyFeedPost.Record);
    console.log(`Posted! URI: ${res.uri}`);
    console.log(`CID: ${res.cid}`);
} catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to create post: ${message}`);
    process.exit(1);
}
