# Monday.com Integration

View your Monday.com boards and items directly within your notes and in a dedicated sidebar panel.

![Sidebar Panel](screenshots/sidebar-panel.png)

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

![Embedded Dashboard - Table View](screenshots/notes-table.png)

![Embedded Dashboard - Cards View](screenshots/notes-table-2.png)

**Options:**
- `board` - Board ID (required if no default set)
- `title` - Custom title (optional)
- `limit` - Maximum items to show (default: 25)
- `columns` - Comma-separated column IDs to display

### Sidebar Panel

Click the calendar-check icon in the left ribbon or use the command palette:
- `Monday.com Integration: Open sidebar`

![Sidebar with Filters](screenshots/sidebar-filters.png)

### Create Tasks

Create Monday.com tasks directly from selected text in your notes:

![Create Task Modal](screenshots/create-task.png)

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

## Security & Privacy

- **Local storage only** - Your API token is stored locally in your vault's plugin data folder (`data.json`)
- **No encryption at rest** - The token is stored in plain text (standard for Obsidian plugins)
- **Direct API communication** - Data is fetched directly from Monday.com's API
- **No third-party servers** - Your data is never sent anywhere except Monday.com
- **Masked input** - The token input field is masked in settings
- **No logging** - Your token is never logged or exposed

**Recommendations:**
- Use a Monday.com API token with minimal required permissions
- Do not sync your vault's `data.json` files to public repositories
- Consider adding `.obsidian/plugins/*/data.json` to your `.gitignore`

## Licence

MIT
