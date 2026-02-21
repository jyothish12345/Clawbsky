#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import {
    AppBskyEmbedImages,
    AppBskyEmbedVideo,
    RichText,
    BskyAgent,
    type AppBskyFeedPost,
    type BlobRef,
    type AtpBasics,
} from "@atproto/api";
import ffmpeg from "fluent-ffmpeg";

// ── Global Options ───────────────────────────────────────────────

interface GlobalOpts {
    json: boolean;
    plain: boolean;
    count: number;
    cursor?: string;
}

const DEFAULT_OPTS: GlobalOpts = {
    json: false,
    plain: false,
    count: 10,
};

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
    const MIME = MIME_MAP[ext];
    if (!MIME) {
        console.error(`Unsupported file type: ${ext}`);
        console.error(`Supported: ${Object.keys(MIME_MAP).join(", ")}`);
        process.exit(1);
    }
    return MIME;
}

function isVideo(mime: string): boolean {
    return mime.startsWith("video/");
}

// ── Video Metadata & Aspect Ratio ─────────────────────────────────

interface VideoMetadata {
    width: number;
    height: number;
    duration: number;
    aspectRatio: string;
    isVertical: boolean;
    isHorizontal: boolean;
    isSquare: boolean;
}

async function getVideoMetadata(filePath: string): Promise<VideoMetadata> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                reject(new Error(`ffprobe failed: ${err.message}`));
                return;
            }

            const videoStream = metadata.streams.find(s => s.codec_type === "video");
            if (!videoStream || !videoStream.width || !videoStream.height) {
                reject(new Error("No video stream found in file"));
                return;
            }

            const width = videoStream.width;
            const height = videoStream.height;
            const duration = metadata.format.duration || 0;

            const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
            const divisor = gcd(width, height);

            resolve({
                width,
                height,
                duration: Math.round(duration * 10) / 10,
                aspectRatio: `${width / divisor}:${height / divisor}`,
                isVertical: height > width,
                isHorizontal: width > height,
                isSquare: width === height,
            });
        });
    });
}

// ── Rich Text Parsing ───────────────────────────────────────────

function parseRichText(text: string): { text: string; facets?: RichText["facets"] } {
    const rt = new RichText({ text });

    const mentionRegex = /@([a-zA-Z0-9._-]+(?:\.[a-zA-Z0-9._-]+)+)/g;
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
        rt.facets?.push({
            index: { byteStart: match.index, byteEnd: match.index + match[0].length },
            features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:unknown" }],
        });
    }

    const linkRegex = /(https?:\/\/[^\s]+)/g;
    while ((match = linkRegex.exec(text)) !== null) {
        rt.facets?.push({
            index: { byteStart: match.index, byteEnd: match.index + match[0].length },
            features: [{ $type: "app.bsky.richtext.facet#link", uri: match[1] }],
        });
    }

    return { text: rt.text, facets: rt.facets };
}

// ── Video upload ───────────────────────────────────────────────

async function uploadVideo(filePath: string, mime: string): Promise<BlobRef> {
    const { agent, login } = await import("./agent.ts");
    await login();
    const fileBytes = fs.readFileSync(filePath);

    const serviceAuth = await agent.com.atproto.server.getServiceAuth({
        aud: `did:web:video.bsky.app`,
        lxm: "com.atproto.repo.uploadBlob",
        exp: Math.floor(Date.now() / 1000) + 60 * 30,
    });

    const uploadUrl = new URL("https://video.bsky.app/xrpc/app.bsky.video.uploadVideo");
    uploadUrl.searchParams.set("did", agent.session!.did);
    uploadUrl.searchParams.set("name", path.basename(filePath));

    let uploadRes = await fetch(uploadUrl.toString(), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${serviceAuth.data.token}`,
            "Content-Type": mime,
            "Content-Length": fileBytes.length.toString(),
        },
        body: fileBytes,
    });

    let jobId: string;
    if (uploadRes.status === 409) {
        const errorData = await uploadRes.json() as { jobId?: string };
        if (errorData.jobId) {
            jobId = errorData.jobId;
            console.log(`Video already exists/uploading, resuming (job: ${jobId})...`);
        } else {
            throw new Error(`Video upload conflict but no jobId returned`);
        }
    } else if (!uploadRes.ok) {
        // Fallback: try PDS audience if video.bsky.app audience failed with 401
        if (uploadRes.status === 401) {
            const pdsHost = agent.pdsUrl?.hostname ?? "bsky.social";
            const fallbackAuth = await agent.com.atproto.server.getServiceAuth({
                aud: `did:web:${pdsHost}`,
                lxm: "com.atproto.repo.uploadBlob",
                exp: Math.floor(Date.now() / 1000) + 60 * 30,
            });
            uploadRes = await fetch(uploadUrl.toString(), {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${fallbackAuth.data.token}`,
                    "Content-Type": mime,
                    "Content-Length": fileBytes.length.toString(),
                },
                body: fileBytes,
            });
            if (uploadRes.status === 409) {
                const errorData = await uploadRes.json() as { jobId?: string };
                jobId = errorData.jobId!;
            } else if (!uploadRes.ok) {
                throw new Error(`Video upload failed: ${uploadRes.status}`);
            } else {
                const uploadData = await uploadRes.json() as { jobId: string };
                jobId = uploadData.jobId;
            }
        } else {
            throw new Error(`Video upload failed: ${uploadRes.status}`);
        }
    } else {
        const uploadData = await uploadRes.json() as { jobId: string };
        jobId = uploadData.jobId;
    }

    console.log(`Video upload confirmed, processing (job: ${jobId})...`);

    let blob: BlobRef | undefined;
    for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));

        // Need to call getJobStatus on the video service, not the PDS
        const statusRes = await fetch(`https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=${jobId}`, {
            headers: { Authorization: `Bearer ${serviceAuth.data.token}` }
        });

        if (!statusRes.ok) continue; // Skip if poll fails temporarily

        const statusData = await statusRes.json() as any;
        const job = statusData.jobStatus;
        if (job.state === "JOB_STATE_COMPLETED" && job.blob) {
            blob = job.blob;
            break;
        }
        if (job.state === "JOB_STATE_FAILED") {
            throw new Error(`Video processing failed: ${job.error ?? "unknown"}`);
        }
    }

    if (!blob) throw new Error("Video processing timed out");
    return blob;
}

// ── Image upload ───────────────────────────────────────────────

async function uploadImage(filePath: string, mime: string): Promise<BlobRef> {
    const { agent, login } = await import("./agent.ts");
    await login();
    const fileBytes = fs.readFileSync(filePath);
    const response = await agent.uploadBlob(fileBytes, { encoding: mime });
    return response.data.blob;
}

// ── Parse Global Options ────────────────────────────────────────

function parseGlobalOpts(args: string[]): { opts: GlobalOpts; remaining: string[] } {
    const opts: GlobalOpts = { ...DEFAULT_OPTS };
    const remaining: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--json") {
            opts.json = true;
        } else if (arg === "--plain") {
            opts.plain = true;
        } else if (arg === "-n" && i + 1 < args.length) {
            opts.count = parseInt(args[++i], 10);
        } else if (arg === "--cursor" && i + 1 < args.length) {
            opts.cursor = args[++i];
        } else if (arg === "--all") {
            opts.count = 100; // Max
        } else {
            remaining.push(arg);
        }
    }

    return { opts, remaining };
}

// ── Help ───────────────────────────────────────────────────────

function printHelp(): void {
    console.log(`clawbsky — Bluesky CLI (Powerful social media experience)

READING:
  clawbsky read <uri>              Read a post with full metadata
  clawbsky thread <uri>            Read full conversation thread
  clawbsky replies <uri> -n 20     List replies to a post
  clawbsky user <handle>           Show user profile info
  clawbsky user-posts <handle> -n 20  User's recent posts

TIMELINES:
  clawbsky home -n 20              Home timeline (feed)
  clawbsky mentions -n 10          Your mentions
  clawbsky likes <handle> -n 10    User's liked posts

SEARCH:
  clawbsky search "query" -n 10     Search posts
  clawbsky search "#hashtag"       Search hashtags

POSTING:
  clawbsky post "text" [media...]          Create a post
  clawbsky reply <uri> "text"              Reply to a post
  clawbsky quote <uri> "text" [media...]   Quote post
  clawbsky thread "post1" "post2"...       Create thread

ENGAGEMENT:
  clawbsky like <uri>              Like a post
  clawbsky unlike <uri>             Unlike a post
  clawbsky repost <uri>            Repost
  clawbsky unrepost <uri>          Undo repost

FOLLOWING:
  clawbsky follow <handle>          Follow user
  clawbsky unfollow <handle>        Unfollow user
  clawbsky followers <handle> -n 20   List followers
  clawbsky following <handle> -n 20   List following

LISTS:
  clawbsky lists                   Your lists
  clawbsky list-timeline <list-id> -n 20  Posts from a list

OUTPUT:
  --json              JSON output
  --plain             Plain text, no formatting
  -n <count>          Number of results (default: 10)
  --cursor <val>      Pagination cursor

EXAMPLES:
  clawbsky home -n 20
  clawbsky user joy.bsky.social
  clawbsky search "AI news"
  clawbsky like at://...
  clawbsky follow joy.bsky.social`);
}

// ── CMD: Read Post ─────────────────────────────────────────────

async function cmdRead(args: string[], opts: GlobalOpts): Promise<void> {
    const uri = args[0];
    if (!uri) {
        console.error("Usage: clawbsky read <uri>");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        // Use getPosts with array of URIs
        const posts = await agent.getPosts({ uris: [uri] });

        if (posts.data.posts.length === 0) {
            console.error("Post not found");
            process.exit(1);
        }

        const post = posts.data.posts[0];
        const record = post.record as AppBskyFeedPost.Record;
        const author = post.author;

        if (opts.json) {
            console.log(JSON.stringify(post, null, 2));
            return;
        }

        console.log(`@${author.handle}`);
        console.log(`${record.text}`);
        console.log(`\n💬 ${post.replyCount} replies | 🔁 ${post.repostCount} reposts | ❤️ ${post.likeCount} likes`);
        console.log(`🔗 ${uri}`);
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Thread ─────────────────────────────────────────────

async function cmdThread(args: string[], opts: GlobalOpts): Promise<void> {
    const uri = args[0];
    if (!uri) {
        console.error("Usage: clawbsky thread <uri>");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        const thread = await agent.getPostThread({ uri, depth: 10 });

        if (opts.json) {
            console.log(JSON.stringify(thread.data.thread, null, 2));
            return;
        }

        function printThread(post: any, indent: number = 0): void {
            const author = post.post?.author;
            const record = post.post?.record;
            if (!author || !record) return;

            const prefix = "  ".repeat(indent);
            console.log(`${prefix}@${author.handle}:`);
            console.log(`${prefix}${record.text}`);
            console.log(`${prefix}---`);

            if (post.parent) {
                printThread(post.parent, indent + 1);
            }
        }

        printThread(thread.data.thread);
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Replies ─────────────────────────────────────────────

async function cmdReplies(args: string[], opts: GlobalOpts): Promise<void> {
    const uri = args[0];
    if (!uri) {
        console.error("Usage: clawbsky replies <uri> [-n count]");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        const posts = await agent.getPostThread({ uri, depth: 1 });

        if (opts.json) {
            console.log(JSON.stringify(posts, null, 2));
            return;
        }

        console.log(`Replies to ${uri}:`);
        // Parse and display replies
        const thread = posts.data.thread;
        if (thread.parent && Array.isArray(thread.parent)) {
            for (const reply of thread.parent.slice(0, opts.count)) {
                const author = reply.post?.author;
                const record = reply.post?.record;
                if (author && record) {
                    console.log(`\n@${author.handle}:`);
                    console.log(`  ${record.text}`);
                    console.log(`  ❤️ ${reply.post?.likeCount || 0}`);
                }
            }
        }
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: User ─────────────────────────────────────────────

async function cmdUser(args: string[], opts: GlobalOpts): Promise<void> {
    const handle = args[0]?.replace("@", "");
    if (!handle) {
        console.error("Usage: clawbsky user <handle>");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        const profile = await agent.getProfile({ actor: handle });

        if (opts.json) {
            console.log(JSON.stringify(profile.data, null, 2));
            return;
        }

        const p = profile.data;
        const postsLabel = opts.plain ? "posts" : "📝";
        const followersLabel = opts.plain ? "followers" : "👥";
        const followingLabel = opts.plain ? "following" : "following";

        console.log(`@${p.handle}`);
        console.log(`${p.displayName || ""}`);
        console.log(`${p.description || ""}`);
        if (opts.plain) {
            console.log(`\n${p.postsCount} ${postsLabel} | ${p.followersCount} ${followersLabel} | following ${p.followsCount}`);
        } else {
            console.log(`\n${postsLabel} ${p.postsCount} posts | ${followersLabel} ${p.followersCount} followers | following ${p.followsCount}`);
        }
        console.log(`${opts.plain ? "Link:" : "🔗"} ${p.joinedAt ? `Joined ${p.joinedAt}` : ""}`);
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: User Posts ─────────────────────────────────────────

async function cmdUserPosts(args: string[], opts: GlobalOpts): Promise<void> {
    const handle = args[0]?.replace("@", "");
    if (!handle) {
        console.error("Usage: clawbsky user-posts <handle> [-n count]");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        const posts = await agent.getAuthorFeed({ actor: handle, limit: opts.count });

        if (opts.json) {
            console.log(JSON.stringify(posts.data.feed, null, 2));
            return;
        }

        for (const item of posts.data.feed) {
            const post = item.post;
            const author = post.author;
            const record = post.record as AppBskyFeedPost.Record;
            console.log(`@${author.handle}:`);
            console.log(`  ${record.text}`);
            if (opts.plain) {
                console.log(`  Reposts: ${post.repostCount} | Likes: ${post.likeCount} | Replies: ${post.replyCount}`);
            } else {
                console.log(`  🔁 ${post.repostCount} | ❤️ ${post.likeCount} | 💬 ${post.replyCount}`);
            }
            console.log("");
        }
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Home Timeline ─────────────────────────────────────────

async function cmdHome(args: string[], opts: GlobalOpts): Promise<void> {
    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        const timeline = await agent.getTimeline({ limit: opts.count, cursor: opts.cursor });

        if (opts.json) {
            console.log(JSON.stringify(timeline.data.feed, null, 2));
            return;
        }

        for (const item of timeline.data.feed) {
            const post = item.post;
            const author = post.author;
            const record = post.record as AppBskyFeedPost.Record;
            console.log(`@${author.handle}:`);
            console.log(`  ${record.text}`);
            console.log(`  🔁 ${post.repostCount} | ❤️ ${post.likeCount}`);
            console.log("");
        }

        if (timeline.data.cursor) {
            console.log(`More: clawbsky home --cursor ${timeline.data.cursor}`);
        }
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Mentions ─────────────────────────────────────────

async function cmdMentions(args: string[], opts: GlobalOpts): Promise<void> {
    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        const notifications = await agent.listNotifications({ limit: opts.count });

        if (opts.json) {
            console.log(JSON.stringify(notifications.data.notifications, null, 2));
            return;
        }

        for (const notif of notifications.data.notifications) {
            if (notif.reason === "mention" || notif.reason === "reply") {
                console.log(`@${notif.author.handle}: ${notif.reason}`);
                if (notif.record) {
                    const record = notif.record as any;
                    console.log(`  ${record.text}`);
                }
                console.log("");
            }
        }
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Likes ─────────────────────────────────────────────

async function cmdLikes(args: string[], opts: GlobalOpts): Promise<void> {
    const handle = args[0]?.replace("@", "");
    if (!handle) {
        console.error("Usage: clawbsky likes <handle> [-n count]");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        const likes = await agent.getActorLikes({ actor: handle, limit: opts.count });

        if (opts.json) {
            console.log(JSON.stringify(likes.data.feed, null, 2));
            return;
        }

        console.log(`Posts liked by @${handle}:`);
        for (const item of likes.data.feed) {
            const post = item.post;
            const author = post.author;
            const record = post.record as AppBskyFeedPost.Record;
            console.log(`@${author.handle}: ${record.text}`);
            console.log("");
        }
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Search ─────────────────────────────────────────────

async function cmdSearch(args: string[], opts: GlobalOpts): Promise<void> {
    const query = args[0];
    if (!query) {
        console.error('Usage: clawbsky search "query" [-n count]');
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        // Use app.bsky.feed.searchPosts directly
        const results = await (agent as any).app.bsky.feed.searchPosts({ q: query, limit: opts.count });

        if (opts.json) {
            console.log(JSON.stringify(results.data.posts, null, 2));
            return;
        }

        console.log(`Results for "${query}":`);
        for (const post of results.data.posts) {
            const author = post.author;
            const record = post.record as AppBskyFeedPost.Record;
            console.log(`@${author.handle}:`);
            console.log(`  ${record.text}`);
            console.log(`  ❤️ ${post.likeCount}`);
            console.log("");
        }
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Like ─────────────────────────────────────────────

async function cmdLike(args: string[]): Promise<void> {
    const uri = args[0];
    if (!uri) {
        console.error("Usage: clawbsky like <uri>");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        // Get the post to retrieve CID
        const posts = await agent.getPosts({ uris: [uri] });
        if (posts.data.posts.length === 0) {
            console.error("Post not found");
            process.exit(1);
        }
        const post = posts.data.posts[0];
        await agent.like(uri, post.cid);
        console.log(`✅ Liked: ${uri}`);
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Unlike ─────────────────────────────────────────────

async function cmdUnlike(args: string[]): Promise<void> {
    const uri = args[0];
    if (!uri) {
        console.error("Usage: clawbsky unlike <uri>");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        // Get the post to retrieve the like URI
        const posts = await agent.getPosts({ uris: [uri] });
        if (posts.data.posts.length === 0) {
            console.error("Post not found");
            process.exit(1);
        }
        const post = posts.data.posts[0];
        const likeUri = post.viewer?.like;
        if (!likeUri) {
            console.error("You haven't liked this post or like info not found.");
            process.exit(1);
        }
        await agent.deleteLike(likeUri);
        console.log(`✅ Unliked: ${uri}`);
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Repost ─────────────────────────────────────────────

async function cmdRepost(args: string[]): Promise<void> {
    const uri = args[0];
    if (!uri) {
        console.error("Usage: clawbsky repost <uri>");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        // Get the post to retrieve CID
        const posts = await agent.getPosts({ uris: [uri] });
        if (posts.data.posts.length === 0) {
            console.error("Post not found");
            process.exit(1);
        }
        const post = posts.data.posts[0];
        await agent.repost(uri, post.cid);
        console.log(`✅ Reposted: ${uri}`);
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Unrepost ─────────────────────────────────────────────

async function cmdUnrepost(args: string[]): Promise<void> {
    const uri = args[0];
    if (!uri) {
        console.error("Usage: clawbsky unrepost <uri>");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        // Get the post to retrieve the repost URI
        const posts = await agent.getPosts({ uris: [uri] });
        if (posts.data.posts.length === 0) {
            console.error("Post not found");
            process.exit(1);
        }
        const post = posts.data.posts[0];
        const repostUri = post.viewer?.repost;
        if (!repostUri) {
            console.error("You haven't reposted this or repost info not found.");
            process.exit(1);
        }
        await agent.deleteRepost(repostUri);
        console.log(`✅ Unreposted: ${uri}`);
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Follow ─────────────────────────────────────────────

async function cmdFollow(args: string[]): Promise<void> {
    const handle = args[0]?.replace("@", "");
    if (!handle) {
        console.error("Usage: clawbsky follow <handle>");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        await agent.follow(handle);
        console.log(`✅ Now following @${handle}`);
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Unfollow ─────────────────────────────────────────────

async function cmdUnfollow(args: string[]): Promise<void> {
    const handle = args[0]?.replace("@", "");
    if (!handle) {
        console.error("Usage: clawbsky unfollow <handle>");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        const profile = await agent.getProfile({ actor: handle });
        const followUri = profile.data.viewer?.following;
        if (!followUri) {
            console.error(`You are not following @${handle}`);
            process.exit(1);
        }

        // deleteFollow is sometimes not on BskyAgent directly, use low level
        const rkey = followUri.split("/").pop();
        if (!rkey) throw new Error("Invalid follow URI");

        await agent.app.bsky.graph.follow.delete({
            repo: agent.session!.did,
            rkey: rkey
        });

        console.log(`✅ Unfollowed @${handle}`);
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Followers ─────────────────────────────────────────

async function cmdFollowers(args: string[], opts: GlobalOpts): Promise<void> {
    const handle = args[0]?.replace("@", "");
    if (!handle) {
        console.error("Usage: clawbsky followers <handle> [-n count]");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        const followers = await agent.getFollowers({ actor: handle, limit: opts.count });

        if (opts.json) {
            console.log(JSON.stringify(followers.data.followers, null, 2));
            return;
        }

        console.log(`Followers of @${handle}:`);
        for (const f of followers.data.followers) {
            console.log(`@${f.handle} ${f.displayName ? `(${f.displayName})` : ""}`);
        }
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Following ─────────────────────────────────────────

async function cmdFollowing(args: string[], opts: GlobalOpts): Promise<void> {
    const handle = args[0]?.replace("@", "");
    if (!handle) {
        console.error("Usage: clawbsky following <handle> [-n count]");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        const following = await agent.getFollows({ actor: handle, limit: opts.count });

        if (opts.json) {
            console.log(JSON.stringify(following.data.follows, null, 2));
            return;
        }

        console.log(`@${handle} follows:`);
        for (const f of following.data.follows) {
            console.log(`@${f.handle} ${f.displayName ? `(${f.displayName})` : ""}`);
        }
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Lists ─────────────────────────────────────────────

async function cmdLists(args: string[], opts: GlobalOpts): Promise<void> {
    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        const lists = await agent.app.bsky.graph.getLists({ actor: agent.session!.did });

        if (opts.json) {
            console.log(JSON.stringify(lists.data.lists, null, 2));
            return;
        }

        console.log("Your lists:");
        if (lists.data.lists.length === 0) {
            console.log("No lists found.");
        }
        for (const list of lists.data.lists) {
            console.log(`- ${list.name} (${list.uri})`);
        }
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: List Timeline ─────────────────────────────────────

async function cmdListTimeline(args: string[], opts: GlobalOpts): Promise<void> {
    const listUri = args[0];
    if (!listUri) {
        console.error("Usage: clawbsky list-timeline <list-uri> [-n count]");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();

    try {
        const posts = await agent.app.bsky.feed.getListFeed({ list: listUri, limit: opts.count });

        if (opts.json) {
            console.log(JSON.stringify(posts.data.feed, null, 2));
            return;
        }

        for (const item of posts.data.feed) {
            const post = item.post;
            const author = post.author;
            const record = post.record as AppBskyFeedPost.Record;
            console.log(`@${author.handle}: ${record.text}`);
        }
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Post ───────────────────────────────────────────────
async function cmdPost(args: string[]): Promise<void> {
    const dryRun = args.includes("--dry-run");
    const altIndex = args.indexOf("--alt");
    const altVideoIndex = args.indexOf("--alt-video");

    let altText: string | undefined;
    let altVideo: string | undefined;

    if (altIndex !== -1 && altIndex + 1 < args.length) altText = args[altIndex + 1];
    if (altVideoIndex !== -1 && altVideoIndex + 1 < args.length) altVideo = args[altVideoIndex + 1];

    const filtered = args.filter((a, idx) =>
        a !== "--dry-run" && a !== "--alt" && a !== "--alt-video" &&
        (altIndex === -1 || idx !== altIndex + 1) &&
        (altVideoIndex === -1 || idx !== altVideoIndex + 1)
    );

    const text = filtered[0];
    if (!text) {
        console.error('Usage: clawbsky post <TEXT> [MEDIA...] [--dry-run] [--alt "desc"]');
        process.exit(1);
    }

    const mediaPaths = filtered.slice(1);
    const imageFiles: string[] = [];
    let videoFile: string | undefined;

    for (const mp of mediaPaths) {
        if (!fs.existsSync(mp)) {
            console.error(`File not found: ${mp}`);
            process.exit(1);
        }
        const mime = mimeFor(mp);

        if (isVideo(mime)) {
            try {
                const meta = await getVideoMetadata(mp);
                console.log(`Video: ${meta.width}x${meta.height} (${meta.aspectRatio})`);
            } catch (e) { /* ignore */ }

            if (videoFile) {
                console.error("Error: only one video per post.");
                process.exit(1);
            }
            videoFile = mp;
        } else {
            imageFiles.push(mp);
        }
    }

    if (dryRun) {
        console.log("[DRY RUN] Would post:");
        console.log(`  Text: ${text}`);
        console.log(`  Images: ${imageFiles.length}, Video: ${videoFile ? 1 : 0}`);
        return;
    }

    const { agent, login } = await import("./agent.ts");
    await login();
    const rich = parseRichText(text);

    const record: Partial<AppBskyFeedPost.Record> = {
        text: rich.text,
        facets: rich.facets,
        createdAt: new Date().toISOString(),
    };

    if (mediaPaths.length > 0) {
        if (videoFile) {
            const mime = mimeFor(videoFile);
            const blob = await uploadVideo(videoFile, mime);
            record.embed = { $type: "app.bsky.embed.video", video: blob, alt: altVideo || "" } as any;
        } else {
            const images: AppBskyEmbedImages.Image[] = [];
            for (let i = 0; i < imageFiles.length; i++) {
                const blob = await uploadImage(imageFiles[i], mimeFor(imageFiles[i]));
                images.push({ image: blob, alt: altText || "" });
            }
            record.embed = { $type: "app.bsky.embed.images", images };
        }
    }

    try {
        const res = await agent.post(record as AppBskyFeedPost.Record);
        console.log(`✅ Posted: ${res.uri}`);
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Reply ─────────────────────────────────────────────

async function cmdReply(args: string[]): Promise<void> {
    const uri = args[0];
    const text = args[1];
    if (!uri || !text) {
        console.error('Usage: clawbsky reply <uri> "text"');
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();
    const rich = parseRichText(text);

    try {
        const posts = await agent.getPosts({ uris: [uri] });
        if (posts.data.posts.length === 0) {
            console.error("Post not found");
            process.exit(1);
        }
        const post = posts.data.posts[0];
        const parentRecord = post.record as AppBskyFeedPost.Record;
        const root = parentRecord.reply?.root || { uri: post.uri, cid: post.cid };
        const parent = { uri: post.uri, cid: post.cid };

        const record: Partial<AppBskyFeedPost.Record> = {
            text: rich.text,
            facets: rich.facets,
            createdAt: new Date().toISOString(),
            reply: { root, parent },
        };

        const res = await agent.post(record as AppBskyFeedPost.Record);
        console.log(`✅ Replied: ${res.uri}`);
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Quote ─────────────────────────────────────────────

async function cmdQuote(args: string[]): Promise<void> {
    const uri = args[0];
    const text = args[1];
    const mediaPaths = args.slice(2);

    if (!uri || !text) {
        console.error('Usage: clawbsky quote <uri> "text" [media...]');
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();
    const rich = parseRichText(text);

    // Get the quoted post
    const quotedPost = await agent.getPost({ uri });

    const record: Partial<AppBskyFeedPost.Record> = {
        text: rich.text,
        facets: rich.facets,
        createdAt: new Date().toISOString(),
    };

    // Add quoted post as embed
    record.embed = {
        $type: "app.bsky.embed.record",
        record: { uri, cid: quotedPost.data.post.cid },
    };

    // Add media if provided
    if (mediaPaths.length > 0) {
        const images: AppBskyEmbedImages.Image[] = [];
        for (const mp of mediaPaths) {
            const blob = await uploadImage(mp, mimeFor(mp));
            images.push({ image: blob, alt: "" });
        }
        record.embed = {
            $type: "app.bsky.embed.recordWithMedia",
            media: { $type: "app.bsky.embed.images", images },
            record: { uri, cid: quotedPost.data.post.cid },
        };
    }

    try {
        const res = await agent.post(record as AppBskyFeedPost.Record);
        console.log(`✅ Quoted: ${res.uri}`);
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

// ── CMD: Thread ─────────────────────────────────────────────

async function cmdThreadPosts(args: string[]): Promise<void> {
    if (args.length < 2) {
        console.error("Usage: clawbsky thread \"post1\" \"post2\" ...");
        process.exit(1);
    }

    const { agent, login } = await import("./agent.ts");
    await login();
    const postedUris: string[] = [];
    let parentUri: string | undefined;
    let parentCid: string | undefined;

    for (let i = 0; i < args.length; i++) {
        const text = args[i];
        const rich = parseRichText(text);

        const record: Partial<AppBskyFeedPost.Record> = {
            text: rich.text,
            facets: rich.facets,
            createdAt: new Date().toISOString(),
        };

        if (parentUri && parentCid) {
            record.reply = {
                root: { uri: postedUris[0], cid: postedUris[1] },
                parent: { uri: parentUri, cid: parentCid },
            };
        }

        try {
            const res = await agent.post(record as AppBskyFeedPost.Record);
            if (i === 0) {
                postedUris.push(res.uri);
            }

            // Get the CID of the post we just created
            const posts = await agent.getPosts({ uris: [res.uri] });
            parentCid = posts.data.posts[0].cid;
            if (i === 0) {
                postedUris.push(parentCid); // Store root cid at index 1 conceptually. We'll track root CID separately.
            }

            parentUri = res.uri;
            console.log(`✅ Post ${i + 1}/${args.length}: ${res.uri}`);
        } catch (err) {
            console.error(`Error: ${err}`);
            process.exit(1);
        }
    }

    console.log(`\nThread complete! ${postedUris.length} posts.`);
}

// ── Entry Point ────────────────────────────────────────────────

const [subcommand, ...rest] = process.argv.slice(2);

// Handle --help before parsing
if (subcommand === "--help" || subcommand === "-h" || !subcommand) {
    printHelp();
    process.exit(0);
}

async function main() {
    const { opts, remaining } = parseGlobalOpts(rest);

    try {
        switch (subcommand) {
            case "read": await cmdRead(remaining, opts); break;
            case "thread":
                if (remaining[0]?.startsWith("at://")) {
                    await cmdThread(remaining, opts);
                } else {
                    await cmdThreadPosts(remaining);
                }
                break;
            case "replies": await cmdReplies(remaining, opts); break;
            case "user": await cmdUser(remaining, opts); break;
            case "user-posts": await cmdUserPosts(remaining, opts); break;
            case "home": await cmdHome(remaining, opts); break;
            case "mentions": await cmdMentions(remaining, opts); break;
            case "likes": await cmdLikes(remaining, opts); break;
            case "search": await cmdSearch(remaining, opts); break;
            case "like": await cmdLike(remaining); break;
            case "unlike": await cmdUnlike(remaining); break;
            case "repost": await cmdRepost(remaining); break;
            case "unrepost": await cmdUnrepost(remaining); break;
            case "follow": await cmdFollow(remaining); break;
            case "unfollow": await cmdUnfollow(remaining); break;
            case "followers": await cmdFollowers(remaining, opts); break;
            case "following": await cmdFollowing(remaining, opts); break;
            case "lists": await cmdLists(remaining, opts); break;
            case "list-timeline": await cmdListTimeline(remaining, opts); break;
            case "add":
            case "post": await cmdPost(remaining); break;
            case "reply": await cmdReply(remaining); break;
            case "quote": await cmdQuote(remaining); break;
            case "thread-posts": await cmdThreadPosts(remaining); break;
            default:
                console.error(`Unknown command: ${subcommand}`);
                printHelp();
                process.exit(1);
        }
    } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
    }
}

main();
