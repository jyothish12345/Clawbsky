import { agent } from "./scripts/agent.ts";
async function run() {
    try {
        console.log("Logged in");
        const profile = await agent.getProfile({ actor: process.env.BLUESKY_HANDLE! });
        console.log(profile.data.handle);
    } catch(e) {
        console.error("Error", e);
    }
}
run();
