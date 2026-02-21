---
name: clawbsky
description: Full-featured Bluesky CLI. Post text, images, and videos. Follow users, like/repost, search threads, and manage lists.
homepage: https://github.com/user/clawbsky
requires:
  env:
    - BLUESKY_HANDLE
    - BLUESKY_APP_PASSWORD
  bins:
    - ffmpeg
    - ffprobe
---

# clawbsky

Full-featured Bluesky CLI with powerful social media commands.

## Setup

```bash
cd /Users/joy/clawsky
npm install
export BLUESKY_HANDLE="yourname.bsky.social"
export BLUESKY_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```

Generate an App Password at: https://bsky.app/settings/app-passwords

## Commands

### Reading

```bash
clawbsky read <uri>              # Read a post with full metadata
clawbsky thread <uri>            # Read full conversation thread
clawbsky replies <uri> -n 20    # List replies to a post
clawbsky user <handle>           # Show user profile info
clawbsky user-posts <handle> -n 20  # User's recent posts
```

### Timelines

```bash
clawbsky home -n 20              # Home timeline (feed)
clawbsky mentions -n 10          # Your mentions
clawbsky likes <handle> -n 10    # User's liked posts
```

### Search

```bash
clawbsky search "query" -n 10    # Search posts
clawbsky search "#hashtag"       # Search hashtags
```

### Posting

```bash
clawbsky add "text" [media...]           # Create a post
clawbsky reply <uri> "text"              # Reply to a post
clawbsky quote <uri> "text" [media...]   # Quote post
clawbsky thread "post1" "post2"...       # Create thread
```

### Engagement

```bash
clawbsky like <uri>              # Like a post
clawbsky unlike <uri>            # Unlike a post
clawbsky repost <uri>            # Repost
clawbsky unrepost <uri>          # Undo repost
```

### Following

```bash
clawbsky follow <handle>         # Follow user
clawbsky unfollow <handle>       # Unfollow user
clawbsky followers <handle> -n 20   # List followers
clawbsky following <handle> -n 20   # List following
```

### Lists

```bash
clawbsky lists                   # Your lists
clawbsky list-timeline <list-id> -n 20  # Posts from a list
```

### Output Options

```bash
--json              # JSON output for raw data piping
--plain             # Plain text mode (removes emojis/formatting)
-n <count>          # Number of results (default: 10)
--cursor <val>      # Pagination cursor for deep history
```

## Usage Examples

```bash
# Read timeline
clawbsky home -n 20

# View profile
clawbsky user joy.bsky.social

# Search
clawbsky search "AI news"

# Like a post
clawbsky like at://did:plc:xxx/app.bsky.feed.post/xxx

# Follow someone
clawbsky follow joy.bsky.social

# Create a thread
clawbsky thread "First post" "Second post" "Third post!"

# Post with image
clawbsky add "Check this out!" photo.jpg --alt "Description"

# Reply to a post
clawbsky reply at://... "Great post!"

# Quote with media
clawbsky quote at://... "My thoughts" screenshot.png
```

## Rich Text

@mentions and links are automatically detected and made clickable:

```bash
clawbsky add "@joy.bsky.social check this! https://bsky.app"
```

## Video Aspect Ratio

Videos are automatically checked for aspect ratio:

```bash
clawbsky add "Watch this" video.mp4
# Output: Video: 1080x1920 (9:16) - Vertical video detected
```
