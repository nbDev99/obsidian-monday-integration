# Monday.com Integration for Obsidian

View your Monday.com boards and items directly within Obsidian notes and in a dedicated sidebar panel.

## Features

- **Embedded Dashboards** - Insert `monday` code blocks to display board items in your notes
- **Sidebar Panel** - Browse all your boards and items in a dedicated view
- **Live Data** - Fetch real-time data from Monday.com's API
- **Status Bar** - Quick sync status display
- **Customisable** - Choose which columns to display, set default boards

## Installation

### Manual Installation

1. Download the latest release from GitHub
2. Extract to your vault's `.obsidian/plugins/monday-integration/` folder
3. Enable the plugin in Obsidian Settings > Community Plugins

### From Community Plugins (Coming Soon)

Search for "Monday.com Integration" in Settings > Community Plugins > Browse

## Setup

1. Get your Monday.com API token:
   - Go to Monday.com
   - Click your profile picture > Developers
   - Select "My Access Tokens"
   - Copy your API token

2. Configure the plugin:
   - Open Obsidian Settings > Monday.com Integration
   - Paste your API token
   - Click "Test" to verify the connection
   - Click "Load boards" to fetch your boards

## Usage

### Embed a Dashboard

Add a code block to any note:

~~~markdown
```monday
board: 1234567890
title: My Tasks
limit: 25
```
~~~

**Options:**
- `board` - Board ID (required if no default set)
- `title` - Custom title (optional)
- `limit` - Maximum items to show (default: 25)
- `columns` - Comma-separated column IDs to display

### Sidebar Panel

Click the calendar-check icon in the left ribbon or use the command palette:
- `Monday.com Integration: Open sidebar`

### Commands

- **Insert board dashboard** - Insert a code block at cursor
- **Open sidebar** - Open the Monday.com sidebar panel
- **Refresh boards** - Force refresh cached board data

## Finding Your Board ID

1. Open your board in Monday.com
2. Look at the URL: `https://yourworkspace.monday.com/boards/1234567890`
3. The number after `/boards/` is your Board ID

## Support

If this plugin helps you stay organised, consider [buying me a coffee](https://buymeacoffee.com/maframpton)!

## Privacy

- Your API token is stored locally in your vault
- Data is fetched directly from Monday.com's API
- No data is sent to third-party servers

## Licence

MIT
