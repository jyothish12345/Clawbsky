# clawbsky 🦋

Full-featured Bluesky CLI with powerful social media commands.

## Features

- ✅ **Post** — text, images (up to 4), videos
- ✅ **Read** — posts, threads, replies, profiles
- ✅ **Timelines** — home, mentions, likes
- ✅ **Search** — posts and hashtags
- ✅ **Engagement** — like, repost, reply, quote
- ✅ **Social** — follow, unfollow, followers, following
- ✅ **Lists** — manage and view list timelines
- ✅ **Threads** — create connected multi-post threads
- ✅ **Rich Text** — @mentions and links auto-detected
- ✅ **Video Aspect Ratio** — automatic detection
- ✅ **Output Options** — JSON, plain text, pagination

## Quick Start

```bash
cd clawbsky
npm install
export BLUESKY_HANDLE="yourname.bsky.social"
export BLUESKY_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
npx tsx scripts/cli.ts --help
```

Generate an App Password at: https://bsky.app/settings/app-passwords

## Commands

### Reading
```bash
clawbsky read <uri>              # Read a post
clawbsky thread <uri>            # Read thread
clawbsky replies <uri> -n 20     # List replies
clawbsky user <handle>           # Profile info
clawbsky user-posts <handle> -n 20  # User's posts
```

### Timelines
```bash
clawbsky home -n 20              # Home timeline
clawbsky mentions -n 10          # Your mentions
clawbsky likes <handle> -n 10    # User's likes
```

### Search
```bash
clawbsky search "query" -n 10    # Search posts
clawbsky search "#hashtag"       # Search hashtags
```

### Posting
```bash
clawbsky post "text" [media...]           # New post
clawbsky reply <uri> "text"            # Reply
clawbsky quote <uri> "text" [media...] # Quote
clawbsky thread "p1" "p2" "p3"...     # Thread
```

### Engagement
```bash
clawbsky like <uri>              # Like
clawbsky unlike <uri>            # Unlike
clawbsky repost <uri>            # Repost
clawbsky unrepost <uri>          # Unrepost
```

### Social
```bash
clawbsky follow <handle>         # Follow
clawbsky unfollow <handle>       # Unfollow
clawbsky followers <handle> -n 20   # Followers
clawbsky following <handle> -n 20   # Following
```

### Lists
```bash
clawbsky lists                   # Your lists
clawbsky list-timeline <id> -n 20   # List posts
```

### Output Options
```bash
--json      # JSON output
--plain     # Plain text
-n <count>  # Results count (default: 10)
--cursor    # Pagination
```

## Examples

```bash
clawbsky home -n 20
clawbsky user joy.bsky.social
clawbsky search "AI news"
clawbsky like at://did:plc:xxx/app.bsky.feed.post/xxx
clawbsky follow joy.bsky.social
clawbsky thread "First post" "Second post" "Third!"
clawbsky post "Sunset!" sunset.jpg --alt "Beautiful orange sunset"
clawbsky reply at://... "Great take!"
```

## Security

- 🔒 Uses App Passwords only
- 🔒 No credentials stored locally
- 🔒 Connects to official Bluesky endpoints

---

Built with [@atproto/api](https://github.com/bluesky-social/atproto)
