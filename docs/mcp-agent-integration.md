# MCP Agent Integration Setup Guide

This guide explains how to connect Claude Code to the content-gen-app MCP server for direct access to brand management, post ideas, and social scheduling.

## Overview

The content-gen-app MCP server exposes 24 tools across two tiers:

- **Tier 1** (read-only or reversible): Brand profiles, post types (categories), ideas, and Buffer connections
- **Tier 2** (irreversible or externally consequential): Category deletion, image generation, and live social scheduling via Buffer

## Step 1: Mint an API Token

An API token is a `cga_`-prefixed credential that authenticates your Claude Code plugin to the MCP server. Tokens are created once and shown once — you cannot recover a token after creation, but you can revoke and create new ones.

1. Log in to your content-gen-app instance
2. Navigate to **Settings** → **API Tokens** (in the config section)
3. Click **Create Token** and give it a label (e.g., "Claude Code MCP")
4. Copy the token immediately — it will not be shown again
5. Save the token securely (e.g., in your Claude Code `.env.local` or password manager)

To revoke a token later, visit the same page and click **Revoke** next to the token you want to disable.

## Step 2: Install the Plugin

The content-gen-app MCP plugin is packaged in this repository as:
- `.claude-plugin/plugin.json` — Plugin metadata
- `.mcp.json` — MCP server configuration

### Manual Installation

If you have the repository checked out locally:

```bash
# From the content-gen-app repo root, copy the plugin to Claude Code's plugin directory:
cp -r .claude-plugin ~/.claude/plugins/content-gen-app
cp .mcp.json ~/.claude/plugins/content-gen-app/
```

Then edit `~/.claude/plugins/content-gen-app/.mcp.json` to:
1. Replace `https://<your-deployment>.vercel.app` with your actual deployed URL (e.g., `https://my-app.vercel.app`)
2. Add the token you minted in Step 1 as the `CONTENT_GEN_APP_API_TOKEN` environment variable

```json
{
  "mcpServers": {
    "content-gen-app": {
      "type": "http",
      "url": "https://my-app.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer ${CONTENT_GEN_APP_API_TOKEN}"
      }
    }
  }
}
```

### Via Claude Code CLI (Recommended)

If you prefer using the `claude` CLI:

```bash
# First, set your token and deployment URL as environment variables:
export CONTENT_GEN_APP_API_TOKEN="cga_..."
export CONTENT_GEN_APP_URL="https://your-deployment.vercel.app"

# Then add the MCP server:
claude mcp add --transport http content-gen-app "$CONTENT_GEN_APP_URL/api/mcp" \
  --header "Authorization: Bearer $CONTENT_GEN_APP_API_TOKEN"
```

Verify the connection by asking Claude to call the `whoami` tool — it should return your user ID.

## Tool Reference

### Tier 1: Safe, Reversible Tools

These tools are read-only or have no side effects on external systems. They can be called freely.

#### Brand Management
- **`get_brand_profile`** — Retrieve the current brand profile (name, voice, audience, proof points, design tokens)
- **`update_brand_profile`** — Overwrite brand profile fields (name, description, audience, voice, colors, fonts, etc.)
- **`extract_brand_from_source`** — Draft a brand profile from a website URL, PDF documents, or conversation history without saving it

#### Post Types (Categories)
- **`list_categories`** — List all defined post types
- **`get_category`** — Retrieve a single post type by key
- **`create_category`** — Create a new post type with style guide, format, aspect ratio, and role-based guides
- **`update_category`** — Update an existing post type's configuration
- **`clear_role_ref_url`** — Remove a promoted role reference image so that role reverts to the category's base style reference
- **`draft_category_turn`** — Advance a conversational draft of a post type by one turn (the model proposes/updates fields and replies with a message)

#### Ideas
- **`list_ideas`** — List post ideas, optionally filtered by post type or status (pending_review, approved, rejected, generating, generated, posted)
- **`get_idea`** — Retrieve a single idea by ID
- **`generate_ideas`** — Generate new AI post ideas for a post type (adds them to the review queue, does not auto-approve)
- **`set_idea_decision`** — Approve or reject a pending idea
- **`create_manual_idea`** — Hand-author an idea (already approved) with custom slide count

#### Post Copy & Adaptation
- **`rewrite_caption`** — Rewrite a post's published copy given a free-text instruction, images, and optional context
- **`adapt_caption`** — Adapt a post's copy to a different platform's conventions (length, hashtags, tone)

#### Buffer Connections
- **`list_buffer_connections`** — List connected Buffer accounts (never returns tokens)
- **`list_buffer_channels`** — List the social channels available on one Buffer connection

#### Utilities
- **`whoami`** — Verify the connection is working (returns your authenticated user ID)

### Tier 2: Irreversible or Externally Consequential Tools

⚠️ **These tools modify data, spend API credit, or reach live external accounts. All Tier 2 tools require an explicit `confirm: true` argument and must be called only after showing the user what will happen and getting explicit approval.**

- **`delete_category`** — Permanently delete a post type (irreversible)
- **`remove_buffer_connection`** — Disconnect a Buffer account from this app (irreversible)
- **`submit_image_generation`** — Submit ideas for AI image generation (spends real API credit; $0.10+ per image)
- **`resubmit_slide`** — Regenerate a single carousel slide (spends real API credit)
- **`schedule_post`** — Schedule generated images to post to Buffer-connected social accounts at a specified future time (⚠️ **REACHES A LIVE SOCIAL ACCOUNT AND CANNOT BE UN-POSTED** — see below)

#### The `schedule_post` Tool: Critical Warning

**`schedule_post` reaches a real, live social media account via Buffer and publishes content that cannot be deleted or recalled once the scheduled time arrives.** It is the only truly irreversible action exposed by this plugin.

**This tool requires two safety guards:**
1. **Explicit confirmation:** Must be called with `confirm: true` only after the model displays exactly what will be posted (images, caption, channels, time) to the human and receives explicit approval.
2. **Future date only:** The `scheduledAt` parameter must be an ISO 8601 datetime string in the future. There is no "post now" tool — all posts are scheduled for a future time to allow final review in Buffer before dispatch.

**Before calling `schedule_post`, your agent MUST:**
- Show the human the full post (all images, caption text, exact caption adaptations per channel)
- Show the target channels and scheduled time
- Explicitly ask "Ready to schedule this?" and wait for confirmation
- Only then call the tool with `confirm: true`

Failure to follow this discipline may result in unintended posts to public social accounts.

## Example Usage

### Simple Brand Lookup
```python
# Pseudo-code — adapt to your agent framework
tool = "get_brand_profile"
result = call_mcp_tool(tool)
print(f"Brand voice: {result.voice}")
```

### Safe Idea Generation
```python
# Generate 5 ideas for the 'newsletter' post type
tool = "generate_ideas"
args = {"categoryKey": "newsletter", "count": 5}
result = call_mcp_tool(tool, args)
print(f"Generated {len(result.ideas)} ideas")

# Manually approve the first one
tool = "set_idea_decision"
args = {"id": result.ideas[0].id, "decision": "approved"}
call_mcp_tool(tool, args, confirm_required=False)  # Tier 1, no confirm needed
```

### Careful Image Generation & Scheduling

```python
# Step 1: Get the approved idea
idea = get_idea("abc123")

# Step 2: Show the human what we're about to do
print(f"Submit {idea.name} for image generation?")
print(f"Cost: ~${0.10 * len(idea.slides)}")
confirm = ask_human("Proceed? (yes/no)")
if not confirm:
    return

# Step 3: Call with confirm=true
tool = "submit_image_generation"
args = {"ideaIds": ["abc123"], "confirm": true}
result = call_mcp_tool(tool, args)

# Step 4: Wait for generation...
# (Poll generation status, or wait via long-running operation)

# Step 5: Show the human exactly what will be posted
post_preview = {
  "channels": [
    {"service": "instagram", "caption": "Our new summer collection..."},
    {"service": "twitter", "caption": "New drops 🎯 Link in bio"}
  ],
  "images": [...],
  "scheduled_at": "2026-07-31T15:00:00Z"
}
print("Ready to post this?")
print(json.dumps(post_preview, indent=2))
confirm = ask_human("Schedule to social media? (yes/no)")
if not confirm:
    return

# Step 6: Only then call schedule_post
tool = "schedule_post"
args = {
  "categoryKey": "newsletter",
  "generationIds": ["abc123"],
  "channels": [...],  // from post_preview
  "caption": "...",
  "scheduledAt": "2026-07-31T15:00:00Z",
  "confirm": true
}
result = call_mcp_tool(tool, args)
print("Post scheduled for social media!")
```

## Troubleshooting

### "unauthorized" Error
- Verify the token starts with `cga_`
- Check that `CONTENT_GEN_APP_API_TOKEN` is set correctly in your environment
- Confirm the token has not been revoked in the Settings → API Tokens UI

### "unknown category" or "not found" Errors
- Use `list_categories` to see all available post types and their keys
- Ensure you're passing the category **key** (e.g., `"newsletter"`), not the id

### MCP Server Not Responding
- Confirm your deployment URL is correct in `.mcp.json`
- Check that the `/api/mcp` endpoint is responding: `curl -H "Authorization: Bearer YOUR_TOKEN" https://your-url/api/mcp`

### "scheduledAt must be in the future"
- Ensure `scheduledAt` is an ISO 8601 string (e.g., `"2026-07-31T15:00:00Z"`)
- The time must be in the future relative to when the request is made

## Advanced: Environment Variable Setup

If you're running Claude Code in a CI/CD environment or want to manage the token via an `.env.local` file:

```bash
# ~/.claude/settings.local.json or project .claude/settings.json:
{
  "env": {
    "CONTENT_GEN_APP_API_TOKEN": "cga_...",
    "CONTENT_GEN_APP_URL": "https://your-deployment.vercel.app"
  }
}
```

Then in your `.mcp.json`:
```json
{
  "mcpServers": {
    "content-gen-app": {
      "type": "http",
      "url": "${CONTENT_GEN_APP_URL}/api/mcp",
      "headers": {
        "Authorization": "Bearer ${CONTENT_GEN_APP_API_TOKEN}"
      }
    }
  }
}
```

## Support

For issues or questions:
- Check the [implementation plan](./superpowers/plans/2026-07-30-mcp-agent-integration.md) for architectural context
- Review the MCP server route: `app/api/mcp/route.ts`
- Ensure your token is valid and not revoked
- Verify your deployment URL is correct and the `/api/mcp` endpoint is reachable
