import {
    Plugin,
    MarkdownRenderChild,
    PluginSettingTab,
    App,
    Setting,
    ItemView,
    WorkspaceLeaf,
    requestUrl,
    Notice,
    Modal,
    TFile,
    normalizePath,
    Menu,
    Editor,
    MarkdownView
} from 'obsidian';

// ============================================================================
// Constants
// ============================================================================

const MONDAY_VIEW_TYPE = 'monday-view';
const MONDAY_TEAM_VIEW_TYPE = 'monday-team-view';
const MONDAY_API_URL = 'https://api.monday.com/v2';

// ============================================================================
// Interfaces
// ============================================================================

interface MondayIntegrationSettings {
    apiToken: string;
    defaultBoardId: string;
    refreshInterval: number; // minutes
    showStatusBar: boolean;
    showStatusDropdown: boolean; // show quick status dropdown in sidebar
    cachedBoards: Board[];
    lastSync: number; // timestamp
    noteFolder: string; // folder for created notes
    noteNameTemplate: string; // template: {name}, {board}, {group}, {id}
}

interface Board {
    id: string;
    name: string;
    description: string | null;
    state: string;
    workspace: { name: string } | null;
}

interface Subitem {
    id: string;
    name: string;
    column_values: ColumnValue[];
}

interface Item {
    id: string;
    name: string;
    created_at: string;
    updated_at: string;
    column_values: ColumnValue[];
    group: { title: string; color: string } | null;
    subitems?: Subitem[];
}

interface ColumnValue {
    id: string;
    text: string;
    value: string | null;
}

interface Column {
    id: string;
    title: string;
    type: string;
}

interface BoardData {
    name: string;
    columns: Column[];
    items: Item[];
}

type DisplayStyle = 'cards' | 'table' | 'compact';

interface TeamMemberStats {
    name: string;
    workingOnIt: number;  // "Working on it" or similar active status
    done: number;         // "Done" status
    overdue: number;      // Not done and past due date
}

// Extended MenuItem interface for submenu support (Obsidian internal API)
interface MenuItemWithSubmenu {
    setSubmenu(): Menu;
}

interface ItemFilter {
    statusInclude: string[];  // Only show these statuses
    statusExclude: string[];  // Hide these statuses
    groupInclude: string[];   // Only show these groups
    groupExclude: string[];   // Hide these groups
}

interface DashboardOptions {
    board: string;
    title: string;
    limit: number;
    columns: string[];
    style: DisplayStyle;
    filter: ItemFilter;
}

const DEFAULT_SETTINGS: MondayIntegrationSettings = {
    apiToken: '',
    defaultBoardId: '',
    refreshInterval: 5,
    showStatusBar: true,
    showStatusDropdown: true,
    cachedBoards: [],
    lastSync: 0,
    noteFolder: 'Monday',
    noteNameTemplate: '{name}'
};

// ============================================================================
// Monday.com API Client
// ============================================================================

class MondayApiClient {
    constructor(private apiToken: string) {}

    async query<T = Record<string, unknown>>(graphql: string): Promise<T> {
        if (!this.apiToken) {
            throw new Error('API token not configured');
        }

        const response = await requestUrl({
            url: MONDAY_API_URL,
            method: 'POST',
            headers: {
                'Authorization': this.apiToken,
                'Content-Type': 'application/json',
                'API-Version': '2024-01'
            },
            body: JSON.stringify({ query: graphql })
        });

        const json = response.json as { data?: T; errors?: Array<{ message: string }> };

        if (json.errors) {
            throw new Error(json.errors[0]?.message || 'API error');
        }

        return json.data as T;
    }

    async testConnection(): Promise<boolean> {
        try {
            interface MeResponse { me: { name: string } }
            const data = await this.query<MeResponse>('{ me { name } }');
            return !!data.me;
        } catch {
            return false;
        }
    }

    async getBoards(): Promise<Board[]> {
        interface BoardsResponse { boards: Board[] }
        const data = await this.query<BoardsResponse>(`
            query {
                boards(limit: 50, state: active) {
                    id
                    name
                    description
                    state
                    workspace { name }
                }
            }
        `);
        return data.boards || [];
    }

    async getBoardData(boardId: string, limit: number = 50): Promise<BoardData | null> {
        interface BoardDataResponse {
            boards: Array<{
                name: string;
                columns: Column[];
                items_page?: { items: Item[] };
            }>;
        }
        const data = await this.query<BoardDataResponse>(`
            query {
                boards(ids: [${boardId}]) {
                    name
                    columns { id title type }
                    items_page(limit: ${limit}) {
                        items {
                            id
                            name
                            created_at
                            updated_at
                            column_values {
                                id
                                text
                                value
                            }
                            group { title color }
                            subitems {
                                id
                                name
                                column_values {
                                    id
                                    text
                                    value
                                }
                            }
                        }
                    }
                }
            }
        `);

        if (!data.boards || data.boards.length === 0) {
            return null;
        }

        const board = data.boards[0];
        return {
            name: board.name,
            columns: board.columns,
            items: board.items_page?.items || []
        };
    }

    async changeItemStatus(boardId: string, itemId: string, columnId: string, statusLabel: string): Promise<boolean> {
        try {
            const value = JSON.stringify({ label: statusLabel });
            interface ChangeColumnResponse { change_column_value: { id: string } }
            await this.query<ChangeColumnResponse>(`
                mutation {
                    change_column_value(
                        board_id: ${boardId},
                        item_id: ${itemId},
                        column_id: "${columnId}",
                        value: ${JSON.stringify(value)}
                    ) {
                        id
                    }
                }
            `);
            return true;
        } catch (error) {
            console.error('Failed to change status:', error);
            throw error;
        }
    }

    async changeSubitemStatus(subitemId: string, columnId: string, statusLabel: string): Promise<boolean> {
        try {
            // First get the subitem's board ID
            interface SubitemBoardResponse {
                items: Array<{ board: { id: string } }>;
            }
            const boardData = await this.query<SubitemBoardResponse>(`
                query {
                    items(ids: [${subitemId}]) {
                        board { id }
                    }
                }
            `);

            const subitemBoardId = boardData.items?.[0]?.board?.id;
            if (!subitemBoardId) {
                throw new Error('Could not find subitem board');
            }

            // Now change the status
            const value = JSON.stringify({ label: statusLabel });
            interface ChangeColumnResponse { change_column_value: { id: string } }
            await this.query<ChangeColumnResponse>(`
                mutation {
                    change_column_value(
                        board_id: ${subitemBoardId},
                        item_id: ${subitemId},
                        column_id: "${columnId}",
                        value: ${JSON.stringify(value)}
                    ) {
                        id
                    }
                }
            `);
            return true;
        } catch (error) {
            console.error('Failed to change subitem status:', error);
            throw error;
        }
    }

    async addItemUpdate(itemId: string, body: string): Promise<boolean> {
        try {
            interface CreateUpdateResponse { create_update: { id: string } }
            await this.query<CreateUpdateResponse>(`
                mutation {
                    create_update(
                        item_id: ${itemId},
                        body: ${JSON.stringify(body)}
                    ) {
                        id
                    }
                }
            `);
            return true;
        } catch (error) {
            console.error('Failed to add update:', error);
            throw error;
        }
    }

    async getStatusColumnSettings(boardId: string, columnId: string): Promise<string[]> {
        try {
            interface ColumnSettingsResponse {
                boards: Array<{
                    columns: Array<{ settings_str: string }>;
                }>;
            }
            const data = await this.query<ColumnSettingsResponse>(`
                query {
                    boards(ids: [${boardId}]) {
                        columns(ids: ["${columnId}"]) {
                            settings_str
                        }
                    }
                }
            `);

            if (data.boards?.[0]?.columns?.[0]?.settings_str) {
                const settings = JSON.parse(data.boards[0].columns[0].settings_str) as { labels?: Record<string, string> };
                if (settings.labels) {
                    return Object.values(settings.labels);
                }
            }
            return [];
        } catch (error) {
            console.error('Failed to get status settings:', error);
            return [];
        }
    }

    async getBoardGroups(boardId: string): Promise<{ id: string; title: string; color: string }[]> {
        try {
            interface BoardGroupsResponse {
                boards: Array<{
                    groups: Array<{ id: string; title: string; color: string }>;
                }>;
            }
            const data = await this.query<BoardGroupsResponse>(`
                query {
                    boards(ids: [${boardId}]) {
                        groups {
                            id
                            title
                            color
                        }
                    }
                }
            `);

            return data.boards?.[0]?.groups || [];
        } catch (error) {
            console.error('Failed to get board groups:', error);
            return [];
        }
    }

    async createItem(boardId: string, groupId: string, itemName: string): Promise<{ id: string; name: string } | null> {
        try {
            interface CreateItemResponse {
                create_item: { id: string; name: string };
            }
            const data = await this.query<CreateItemResponse>(`
                mutation {
                    create_item(
                        board_id: ${boardId},
                        group_id: "${groupId}",
                        item_name: ${JSON.stringify(itemName)}
                    ) {
                        id
                        name
                    }
                }
            `);

            return data.create_item || null;
        } catch (error) {
            console.error('Failed to create item:', error);
            throw error;
        }
    }

    async createSubitem(parentItemId: string, subitemName: string): Promise<{ id: string; name: string } | null> {
        try {
            interface CreateSubitemResponse {
                create_subitem: { id: string; name: string };
            }
            const data = await this.query<CreateSubitemResponse>(`
                mutation {
                    create_subitem(
                        parent_item_id: ${parentItemId},
                        item_name: ${JSON.stringify(subitemName)}
                    ) {
                        id
                        name
                    }
                }
            `);

            return data.create_subitem || null;
        } catch (error) {
            console.error('Failed to create subitem:', error);
            throw error;
        }
    }

    async getUsers(): Promise<{ id: string; name: string; email: string }[]> {
        try {
            interface UsersResponse {
                users: Array<{ id: string; name: string; email: string }>;
            }
            const data = await this.query<UsersResponse>(`
                query {
                    users(limit: 100) {
                        id
                        name
                        email
                    }
                }
            `);
            return data.users || [];
        } catch (error) {
            console.error('Failed to get users:', error);
            throw error;
        }
    }

    async assignPerson(boardId: string, itemId: string, columnId: string, personIds: number[]): Promise<boolean> {
        try {
            const personsValue = JSON.stringify({
                personsAndTeams: personIds.map(id => ({ id, kind: 'person' }))
            });

            interface ChangeColumnResponse {
                change_column_value: { id: string };
            }
            await this.query<ChangeColumnResponse>(`
                mutation {
                    change_column_value(
                        board_id: ${boardId},
                        item_id: ${itemId},
                        column_id: ${JSON.stringify(columnId)},
                        value: ${JSON.stringify(personsValue)}
                    ) {
                        id
                    }
                }
            `);
            return true;
        } catch (error) {
            console.error('Failed to assign person:', error);
            throw error;
        }
    }

    async assignPersonToSubitem(parentItemId: string, subitemId: string, columnId: string, personIds: number[]): Promise<boolean> {
        try {
            // For subitems, we need to get the subitem's board ID first
            interface SubitemBoardResponse {
                items: Array<{ board: { id: string } }>;
            }
            const boardData = await this.query<SubitemBoardResponse>(`
                query {
                    items(ids: [${subitemId}]) {
                        board { id }
                    }
                }
            `);

            const subitemBoardId = boardData.items?.[0]?.board?.id;
            if (!subitemBoardId) {
                throw new Error('Could not find subitem board');
            }

            return await this.assignPerson(subitemBoardId, subitemId, columnId, personIds);
        } catch (error) {
            console.error('Failed to assign person to subitem:', error);
            throw error;
        }
    }
}

// ============================================================================
// Dashboard Renderer (Code Block)
// ============================================================================

class MondayDashboardRenderer extends MarkdownRenderChild {
    private plugin: MondayIntegrationPlugin;
    private options: DashboardOptions;

    constructor(
        containerEl: HTMLElement,
        plugin: MondayIntegrationPlugin,
        options: DashboardOptions
    ) {
        super(containerEl);
        this.plugin = plugin;
        this.options = options;
    }

    onload() {
        void this.render();
    }

    async render() {
        const container = this.containerEl;
        container.empty();
        container.addClass('monday-dashboard');

        // Check for API token
        if (!this.plugin.settings.apiToken) {
            this.renderError(container, 'API token not configured. Go to Settings > Monday.com Integration.');
            return;
        }

        // Check for board ID
        const boardId = this.options.board || this.plugin.settings.defaultBoardId;
        if (!boardId) {
            this.renderError(container, 'No board specified. Add "board: YOUR_BOARD_ID" to the code block.');
            return;
        }

        // Show loading
        this.renderLoading(container);

        try {
            const boardData = await this.plugin.apiClient.getBoardData(boardId, this.options.limit * 2); // Fetch extra for filtering

            if (!boardData) {
                container.empty();
                this.renderError(container, 'Board not found or you don\'t have access.');
                return;
            }

            // Apply status filter
            const filteredItems = this.filterItems(boardData.items, boardData.columns);
            const filteredBoardData: BoardData = {
                ...boardData,
                items: filteredItems.slice(0, this.options.limit)
            };

            container.empty();
            this.renderBoard(container, filteredBoardData);
        } catch (error) {
            container.empty();
            this.renderError(container, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private filterItems(items: Item[], columns: Column[]): Item[] {
        const { statusInclude, statusExclude, groupInclude, groupExclude } = this.options.filter;

        // If no filters, return all items
        if (statusInclude.length === 0 && statusExclude.length === 0 &&
            groupInclude.length === 0 && groupExclude.length === 0) {
            return items;
        }

        // Find status column(s)
        const statusColumns = columns.filter(c => c.type === 'status');

        return items.filter(item => {
            // --- Group filtering ---
            const itemGroup = item.group?.title?.toLowerCase() || '';

            // Check group exclude list
            for (const excludeGroup of groupExclude) {
                if (itemGroup.includes(excludeGroup) || excludeGroup.includes(itemGroup)) {
                    return false;
                }
            }

            // Check group include list
            if (groupInclude.length > 0) {
                const groupMatch = groupInclude.some(includeGroup =>
                    itemGroup.includes(includeGroup) || includeGroup.includes(itemGroup)
                );
                if (!groupMatch) {
                    return false;
                }
            }

            // --- Status filtering ---
            const itemStatuses: string[] = [];
            for (const statusCol of statusColumns) {
                const colValue = item.column_values.find(cv => cv.id === statusCol.id);
                if (colValue?.text) {
                    itemStatuses.push(colValue.text.toLowerCase());
                }
            }

            // Check status exclude list
            for (const excludeStatus of statusExclude) {
                if (itemStatuses.some(s => s.includes(excludeStatus) || excludeStatus.includes(s))) {
                    return false;
                }
            }

            // Check status include list
            if (statusInclude.length > 0) {
                return statusInclude.some(includeStatus =>
                    itemStatuses.some(s => s.includes(includeStatus) || includeStatus.includes(s))
                );
            }

            return true;
        });
    }

    private renderLoading(container: HTMLElement) {
        const loadingEl = container.createEl('div', { cls: 'monday-loading' });
        loadingEl.createEl('div', { cls: 'monday-spinner' });
        loadingEl.createEl('div', { text: 'Loading Monday.com data...', cls: 'monday-loading-text' });
    }

    private renderError(container: HTMLElement, message: string) {
        const errorEl = container.createEl('div', { cls: 'monday-error' });
        errorEl.createEl('span', { text: message });
    }

    private renderBoard(container: HTMLElement, boardData: BoardData) {
        // Title
        const title = this.options.title || boardData.name;
        container.createEl('div', { text: title, cls: 'monday-board-title' });

        // Refresh button and style indicator
        const headerEl = container.createEl('div', { cls: 'monday-header-actions' });
        headerEl.createEl('span', { text: this.options.style, cls: 'monday-style-badge' });
        const refreshBtn = headerEl.createEl('button', { text: 'Refresh', cls: 'monday-refresh-btn' });
        refreshBtn.addEventListener('click', () => void this.render());

        if (boardData.items.length === 0) {
            container.createEl('div', { text: 'No items found', cls: 'monday-empty' });
            return;
        }

        // Render based on style
        switch (this.options.style) {
            case 'table':
                this.renderTable(container, boardData);
                break;
            case 'compact':
                this.renderCompact(container, boardData);
                break;
            case 'cards':
            default:
                this.renderCards(container, boardData);
                break;
        }

        // Item count
        container.createEl('div', {
            text: `Showing ${boardData.items.length} items`,
            cls: 'monday-item-count'
        });
    }

    private getColumnsToShow(boardData: BoardData): Column[] {
        return this.options.columns.length > 0
            ? boardData.columns.filter(c => this.options.columns.includes(c.id) || this.options.columns.includes(c.title.toLowerCase()))
            : boardData.columns.filter(c => c.type === 'status' || c.type === 'date' || c.type === 'person');
    }

    private renderStatusBadge(container: HTMLElement, colValue: ColumnValue, column: Column) {
        if (column.type === 'status') {
            const statusBadge = container.createEl('span', {
                text: colValue.text,
                cls: 'monday-status-badge'
            });
            try {
                const valueObj = colValue.value ? JSON.parse(colValue.value) : null;
                if (valueObj?.label_style?.color) {
                    statusBadge.style.backgroundColor = valueObj.label_style.color;
                }
            } catch {
                // Use default colour
            }
        } else {
            container.createEl('span', { text: colValue.text });
        }
    }

    private renderCards(container: HTMLElement, boardData: BoardData) {
        const itemsContainer = container.createEl('div', { cls: 'monday-items monday-items-cards' });
        const columnsToShow = this.getColumnsToShow(boardData);

        for (const item of boardData.items) {
            const card = itemsContainer.createEl('div', { cls: 'monday-item-card' });

            // Item name
            card.createEl('div', { text: item.name, cls: 'monday-item-name' });

            // Group badge
            if (item.group) {
                const groupBadge = card.createEl('span', {
                    text: item.group.title,
                    cls: 'monday-group-badge'
                });
                groupBadge.style.backgroundColor = item.group.color || '#579bfc';
            }

            // Column values
            const columnsEl = card.createEl('div', { cls: 'monday-item-columns' });

            for (const column of columnsToShow) {
                const colValue = item.column_values.find(cv => cv.id === column.id);
                if (colValue && colValue.text) {
                    const colEl = columnsEl.createEl('div', { cls: 'monday-column-value' });
                    colEl.createEl('span', { text: column.title + ': ', cls: 'monday-column-label' });
                    this.renderStatusBadge(colEl, colValue, column);
                }
            }
        }
    }

    private renderTable(container: HTMLElement, boardData: BoardData) {
        const tableContainer = container.createEl('div', { cls: 'monday-table-container' });
        const table = tableContainer.createEl('table', { cls: 'monday-table' });
        const columnsToShow = this.getColumnsToShow(boardData);

        // Header row
        const thead = table.createEl('thead');
        const headerRow = thead.createEl('tr');
        headerRow.createEl('th', { text: 'Item' });
        headerRow.createEl('th', { text: 'Group' });
        for (const column of columnsToShow) {
            headerRow.createEl('th', { text: column.title });
        }

        // Body rows
        const tbody = table.createEl('tbody');
        for (const item of boardData.items) {
            const row = tbody.createEl('tr');

            // Item name
            row.createEl('td', { text: item.name, cls: 'monday-table-item-name' });

            // Group
            const groupCell = row.createEl('td');
            if (item.group) {
                const groupBadge = groupCell.createEl('span', {
                    text: item.group.title,
                    cls: 'monday-group-badge monday-group-badge-small'
                });
                groupBadge.style.backgroundColor = item.group.color || '#579bfc';
            }

            // Column values
            for (const column of columnsToShow) {
                const cell = row.createEl('td');
                const colValue = item.column_values.find(cv => cv.id === column.id);
                if (colValue && colValue.text) {
                    this.renderStatusBadge(cell, colValue, column);
                }
            }
        }
    }

    private renderCompact(container: HTMLElement, boardData: BoardData) {
        const listContainer = container.createEl('div', { cls: 'monday-items monday-items-compact' });
        const columnsToShow = this.getColumnsToShow(boardData);

        for (const item of boardData.items) {
            const itemEl = listContainer.createEl('div', { cls: 'monday-compact-item' });

            // Status badge first (if present)
            const statusCol = columnsToShow.find(c => c.type === 'status');
            if (statusCol) {
                const colValue = item.column_values.find(cv => cv.id === statusCol.id);
                if (colValue && colValue.text) {
                    this.renderStatusBadge(itemEl, colValue, statusCol);
                }
            }

            // Item name
            itemEl.createEl('span', { text: item.name, cls: 'monday-compact-name' });

            // Group badge (small)
            if (item.group) {
                const groupBadge = itemEl.createEl('span', {
                    text: item.group.title,
                    cls: 'monday-group-badge monday-group-badge-small'
                });
                groupBadge.style.backgroundColor = item.group.color || '#579bfc';
            }
        }
    }
}

function parseDashboardOptions(source: string): DashboardOptions {
    const options: DashboardOptions = {
        board: '',
        title: '',
        limit: 25,
        columns: [],
        style: 'cards',
        filter: {
            statusInclude: [],
            statusExclude: [],
            groupInclude: [],
            groupExclude: []
        }
    };

    const lines = source.trim().split('\n');
    for (const line of lines) {
        const [key, ...valueParts] = line.split(':');
        const value = valueParts.join(':').trim();

        switch (key.trim().toLowerCase()) {
            case 'board':
                options.board = value;
                break;
            case 'title':
                options.title = value;
                break;
            case 'limit':
                options.limit = parseInt(value) || 25;
                break;
            case 'columns':
                options.columns = value.split(',').map(c => c.trim().toLowerCase()).filter(c => c);
                break;
            case 'style': {
                const styleValue = value.toLowerCase();
                if (styleValue === 'table' || styleValue === 'compact' || styleValue === 'cards') {
                    options.style = styleValue;
                }
                break;
            }
            case 'status':
            case 'filter': {
                // Parse status filter: "On Hold, Working on it" or "!Done, !Stuck" (exclude)
                const statuses = value.split(',').map(s => s.trim()).filter(s => s);
                for (const status of statuses) {
                    if (status.startsWith('!')) {
                        options.filter.statusExclude.push(status.slice(1).toLowerCase());
                    } else {
                        options.filter.statusInclude.push(status.toLowerCase());
                    }
                }
                break;
            }
            case 'group': {
                // Parse group filter: "Sprint 1, Backlog" or "!Done, !Archive" (exclude)
                const groups = value.split(',').map(g => g.trim()).filter(g => g);
                for (const group of groups) {
                    if (group.startsWith('!')) {
                        options.filter.groupExclude.push(group.slice(1).toLowerCase());
                    } else {
                        options.filter.groupInclude.push(group.toLowerCase());
                    }
                }
                break;
            }
        }
    }

    return options;
}

// ============================================================================
// Sidebar View
// ============================================================================

interface SidebarFilter {
    selected: Set<string>;  // Selected values
    mode: 'include' | 'exclude';  // Show only selected vs hide selected
}

class MondayView extends ItemView {
    private plugin: MondayIntegrationPlugin;
    private selectedBoardId: string | null = null;
    private currentBoardData: BoardData | null = null;
    private statusFilter: SidebarFilter = { selected: new Set(), mode: 'include' };
    private groupFilter: SidebarFilter = { selected: new Set(), mode: 'include' };
    private personFilter: string | null = null; // Filter by team member name
    private availableStatuses: Map<string, string[]> = new Map(); // columnId -> status labels
    private expandedItems: Set<string> = new Set(); // Track expanded items for subitems

    constructor(leaf: WorkspaceLeaf, plugin: MondayIntegrationPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return MONDAY_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Monday.com';
    }

    getIcon(): string {
        return 'calendar-check';
    }

    async onOpen() {
        // Use shared board selection, or fall back to default board
        if (!this.selectedBoardId) {
            this.selectedBoardId = this.plugin.currentBoardId || this.plugin.settings.defaultBoardId || null;
        }
        await this.render();
    }

    async render() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('monday-sidebar');

        // Check for API token
        if (!this.plugin.settings.apiToken) {
            const errorEl = container.createEl('div', { cls: 'monday-sidebar-error' });
            errorEl.createEl('p', { text: 'API token not configured.' });
            const settingsBtn = errorEl.createEl('button', { text: 'Open settings' });
            settingsBtn.addEventListener('click', () => {
                // @ts-ignore - Obsidian internal API
                this.app.setting.open();
                // @ts-ignore
                this.app.setting.openTabById('monday-integration');
            });
            return;
        }

        // Header
        const headerEl = container.createEl('div', { cls: 'monday-sidebar-header' });
        headerEl.createEl('h4', { text: 'Monday.com' });

        const refreshBtn = headerEl.createEl('button', { cls: 'monday-sidebar-refresh' });
        refreshBtn.setText('↻'); // Refresh icon
        refreshBtn.title = 'Refresh boards';
        refreshBtn.addEventListener('click', () => void this.refreshBoards());

        // Board selector
        const selectorEl = container.createEl('div', { cls: 'monday-board-selector' });
        const selectEl = selectorEl.createEl('select', { cls: 'monday-board-select' });

        const defaultOption = selectEl.createEl('option', { text: 'Select a board...', value: '' });
        defaultOption.disabled = true;
        defaultOption.selected = !this.selectedBoardId;

        for (const board of this.plugin.settings.cachedBoards) {
            const option = selectEl.createEl('option', {
                text: board.name,
                value: board.id
            });
            if (board.id === this.selectedBoardId) {
                option.selected = true;
            }
        }

        selectEl.addEventListener('change', (e) => {
            const boardId = (e.target as HTMLSelectElement).value;
            this.selectedBoardId = boardId;
            this.statusFilter = { selected: new Set(), mode: 'include' };
            this.groupFilter = { selected: new Set(), mode: 'include' };
            this.personFilter = null;
            this.currentBoardData = null;
            void this.loadAndRenderBoard(container);
            // Sync to team view
            this.plugin.syncBoardSelection(boardId, 'main');
        });

        // Filters container (populated after board is loaded)
        container.createEl('div', { cls: 'monday-sidebar-filters' });

        // Items container
        const itemsContainer = container.createEl('div', { cls: 'monday-sidebar-items' });

        if (this.selectedBoardId) {
            await this.loadAndRenderBoard(container);
        } else if (this.plugin.settings.cachedBoards.length === 0) {
            itemsContainer.createEl('p', { text: 'Click refresh to load boards.', cls: 'monday-sidebar-hint' });
        }
    }

    private async loadAndRenderBoard(container: Element) {
        const htmlContainer = container as HTMLElement;
        const filtersContainer = htmlContainer.querySelector('.monday-sidebar-filters') as HTMLElement;
        const itemsContainer = htmlContainer.querySelector('.monday-sidebar-items') as HTMLElement;

        if (!this.selectedBoardId) return;

        // Show loading
        if (itemsContainer) {
            itemsContainer.empty();
            itemsContainer.createEl('div', { text: 'Loading items...', cls: 'monday-sidebar-loading' });
        }

        try {
            // Fetch board data if not cached
            const isFirstLoad = !this.currentBoardData;
            if (!this.currentBoardData) {
                this.currentBoardData = await this.plugin.apiClient.getBoardData(this.selectedBoardId, 100);

                // Fetch available status options for status columns
                if (this.currentBoardData) {
                    const statusColumns = this.currentBoardData.columns.filter(c => c.type === 'status');
                    for (const col of statusColumns) {
                        const statuses = await this.plugin.apiClient.getStatusColumnSettings(this.selectedBoardId, col.id);
                        if (statuses.length > 0) {
                            this.availableStatuses.set(col.id, statuses);
                        }
                    }
                }
            }

            // Auto-exclude "Done" status on first load
            if (isFirstLoad && this.currentBoardData) {
                const statusColumns = this.currentBoardData.columns.filter(c => c.type === 'status');
                for (const col of statusColumns) {
                    const statuses = this.availableStatuses.get(col.id) || [];
                    // Find "Done" status (case-insensitive)
                    const doneStatus = statuses.find(s => s.toLowerCase() === 'done');
                    if (doneStatus) {
                        this.statusFilter.selected.add(doneStatus);
                        this.statusFilter.mode = 'exclude';
                        break;
                    }
                }
            }

            if (!this.currentBoardData) {
                if (itemsContainer) {
                    itemsContainer.empty();
                    itemsContainer.createEl('p', { text: 'Board not found.' });
                }
                return;
            }

            // Render filters
            this.renderFilters(filtersContainer, this.currentBoardData);

            // Render items
            this.renderFilteredItems(itemsContainer, this.currentBoardData);
        } catch (error) {
            if (itemsContainer) {
                itemsContainer.empty();
                itemsContainer.createEl('p', {
                    text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                    cls: 'monday-sidebar-error'
                });
            }
        }
    }

    private renderFilters(container: HTMLElement, boardData: BoardData) {
        if (!container) return;
        container.empty();

        // Get unique statuses
        const statuses = new Set<string>();
        const statusColumns = boardData.columns.filter(c => c.type === 'status');
        for (const item of boardData.items) {
            for (const statusCol of statusColumns) {
                const colValue = item.column_values.find(cv => cv.id === statusCol.id);
                if (colValue?.text) {
                    statuses.add(colValue.text);
                }
            }
        }

        // Get unique groups
        const groups = new Set<string>();
        for (const item of boardData.items) {
            if (item.group?.title) {
                groups.add(item.group.title);
            }
        }

        const refreshItems = () => {
            const itemsContainer = container.parentElement?.querySelector('.monday-sidebar-items') as HTMLElement;
            if (itemsContainer && this.currentBoardData) {
                this.renderFilteredItems(itemsContainer, this.currentBoardData);
            }
        };

        // Status filter checkboxes
        if (statuses.size > 0) {
            const statusSection = container.createEl('div', { cls: 'monday-filter-section collapsed' });

            // Header (clickable to expand/collapse)
            const statusHeader = statusSection.createEl('div', { cls: 'monday-filter-header' });

            const statusTitleArea = statusHeader.createEl('div', { cls: 'monday-filter-title-area' });
            statusTitleArea.createEl('span', { cls: 'monday-filter-chevron', text: '▶' });
            statusTitleArea.createEl('span', { text: 'Status', cls: 'monday-filter-title' });

            // Show count when collapsed
            const statusCount = statusTitleArea.createEl('span', { cls: 'monday-filter-count' });
            const updateStatusCount = () => {
                const count = this.statusFilter.selected.size;
                statusCount.textContent = count > 0 ? `(${count} ${this.statusFilter.mode === 'exclude' ? 'hidden' : 'selected'})` : '';
            };
            updateStatusCount();

            statusTitleArea.addEventListener('click', () => {
                statusSection.classList.toggle('collapsed');
            });

            const statusControls = statusHeader.createEl('div', { cls: 'monday-filter-controls' });

            const statusModeBtn = statusControls.createEl('button', {
                cls: `monday-filter-mode ${this.statusFilter.mode}`,
                text: this.statusFilter.mode === 'include' ? 'Show' : 'Hide'
            });
            statusModeBtn.title = this.statusFilter.mode === 'include'
                ? 'Show only selected (click to switch to Hide mode)'
                : 'Hide selected (click to switch to Show mode)';
            statusModeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.statusFilter.mode = this.statusFilter.mode === 'include' ? 'exclude' : 'include';
                statusModeBtn.textContent = this.statusFilter.mode === 'include' ? 'Show' : 'Hide';
                statusModeBtn.className = `monday-filter-mode ${this.statusFilter.mode}`;
                statusModeBtn.title = this.statusFilter.mode === 'include'
                    ? 'Show only selected (click to switch to Hide mode)'
                    : 'Hide selected (click to switch to Show mode)';
                updateStatusCount();
                refreshItems();
            });

            // Clear button
            const statusClearBtn = statusControls.createEl('button', {
                cls: 'monday-filter-clear',
                text: '✕'
            });
            statusClearBtn.title = 'Clear all';
            statusClearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.statusFilter.selected.clear();
                statusSection.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
                    (cb as HTMLInputElement).checked = false;
                });
                updateStatusCount();
                refreshItems();
            });

            // Checkbox list (collapsible)
            const statusList = statusSection.createEl('div', { cls: 'monday-filter-list' });
            for (const status of Array.from(statuses).sort()) {
                const label = statusList.createEl('label', { cls: 'monday-filter-checkbox' });
                const checkbox = label.createEl('input', { type: 'checkbox' });
                checkbox.checked = this.statusFilter.selected.has(status);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        this.statusFilter.selected.add(status);
                    } else {
                        this.statusFilter.selected.delete(status);
                    }
                    updateStatusCount();
                    refreshItems();
                });
                label.createEl('span', { text: status });
            }
        }

        // Group filter checkboxes
        if (groups.size > 0) {
            const groupSection = container.createEl('div', { cls: 'monday-filter-section collapsed' });

            // Header (clickable to expand/collapse)
            const groupHeader = groupSection.createEl('div', { cls: 'monday-filter-header' });

            const groupTitleArea = groupHeader.createEl('div', { cls: 'monday-filter-title-area' });
            groupTitleArea.createEl('span', { cls: 'monday-filter-chevron', text: '▶' });
            groupTitleArea.createEl('span', { text: 'Group', cls: 'monday-filter-title' });

            // Show count when collapsed
            const groupCount = groupTitleArea.createEl('span', { cls: 'monday-filter-count' });
            const updateGroupCount = () => {
                const count = this.groupFilter.selected.size;
                groupCount.textContent = count > 0 ? `(${count} ${this.groupFilter.mode === 'exclude' ? 'hidden' : 'selected'})` : '';
            };
            updateGroupCount();

            groupTitleArea.addEventListener('click', () => {
                groupSection.classList.toggle('collapsed');
            });

            const groupControls = groupHeader.createEl('div', { cls: 'monday-filter-controls' });

            const groupModeBtn = groupControls.createEl('button', {
                cls: `monday-filter-mode ${this.groupFilter.mode}`,
                text: this.groupFilter.mode === 'include' ? 'Show' : 'Hide'
            });
            groupModeBtn.title = this.groupFilter.mode === 'include'
                ? 'Show only selected (click to switch to Hide mode)'
                : 'Hide selected (click to switch to Show mode)';
            groupModeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.groupFilter.mode = this.groupFilter.mode === 'include' ? 'exclude' : 'include';
                groupModeBtn.textContent = this.groupFilter.mode === 'include' ? 'Show' : 'Hide';
                groupModeBtn.className = `monday-filter-mode ${this.groupFilter.mode}`;
                groupModeBtn.title = this.groupFilter.mode === 'include'
                    ? 'Show only selected (click to switch to Hide mode)'
                    : 'Hide selected (click to switch to Show mode)';
                updateGroupCount();
                refreshItems();
            });

            // Clear button
            const groupClearBtn = groupControls.createEl('button', {
                cls: 'monday-filter-clear',
                text: '✕'
            });
            groupClearBtn.title = 'Clear all';
            groupClearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.groupFilter.selected.clear();
                groupSection.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
                    (cb as HTMLInputElement).checked = false;
                });
                updateGroupCount();
                refreshItems();
            });

            // Checkbox list (collapsible)
            const groupList = groupSection.createEl('div', { cls: 'monday-filter-list' });
            for (const group of Array.from(groups).sort()) {
                const label = groupList.createEl('label', { cls: 'monday-filter-checkbox' });
                const checkbox = label.createEl('input', { type: 'checkbox' });
                checkbox.checked = this.groupFilter.selected.has(group);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        this.groupFilter.selected.add(group);
                    } else {
                        this.groupFilter.selected.delete(group);
                    }
                    updateGroupCount();
                    refreshItems();
                });
                label.createEl('span', { text: group });
            }
        }
    }

    private renderFilteredItems(container: HTMLElement, boardData: BoardData) {
        container.empty();

        // Filter items
        let filteredItems = boardData.items;

        // Apply status filter
        if (this.statusFilter.selected.size > 0) {
            const statusColumns = boardData.columns.filter(c => c.type === 'status');
            filteredItems = filteredItems.filter(item => {
                // Get item's status
                let itemStatus = '';
                for (const statusCol of statusColumns) {
                    const colValue = item.column_values.find(cv => cv.id === statusCol.id);
                    if (colValue?.text) {
                        itemStatus = colValue.text;
                        break;
                    }
                }

                const isSelected = this.statusFilter.selected.has(itemStatus);

                // Include mode: show only selected
                // Exclude mode: hide selected
                return this.statusFilter.mode === 'include' ? isSelected : !isSelected;
            });
        }

        // Apply group filter
        if (this.groupFilter.selected.size > 0) {
            filteredItems = filteredItems.filter(item => {
                const itemGroup = item.group?.title || '';
                const isSelected = this.groupFilter.selected.has(itemGroup);

                return this.groupFilter.mode === 'include' ? isSelected : !isSelected;
            });
        }

        // Apply person filter
        if (this.personFilter) {
            const peopleColumns = boardData.columns.filter(c => c.type === 'people' || c.type === 'multiple-person');
            filteredItems = filteredItems.filter(item => {
                const assignees = this.getItemAssignees(item, peopleColumns);
                return assignees.includes(this.personFilter!);
            });
        }

        if (filteredItems.length === 0) {
            container.createEl('p', { text: 'No items match the filters.', cls: 'monday-sidebar-hint' });
            return;
        }

        // Group items by group
        const groupedItems = new Map<string, Item[]>();
        for (const item of filteredItems) {
            const groupName = item.group?.title || 'No Group';
            if (!groupedItems.has(groupName)) {
                groupedItems.set(groupName, []);
            }
            groupedItems.get(groupName)!.push(item);
        }

        // Render grouped items
        for (const [groupName, items] of groupedItems) {
            const groupEl = container.createEl('div', { cls: 'monday-sidebar-group' });
            const groupTitleEl = groupEl.createEl('div', { text: groupName, cls: 'monday-sidebar-group-title' });

            // Apply rotating group colours
            const groupColors = ['#00c875', '#fdab3d', '#a25ddc', '#579bfc', '#e2445c'];
            const colorIndex = Array.from(groupedItems.keys()).indexOf(groupName) % groupColors.length;
            const hexColor = groupColors[colorIndex];
            groupTitleEl.style.borderLeftColor = hexColor;
            groupTitleEl.style.color = hexColor;

            for (const item of items) {
                const itemWrapper = groupEl.createEl('div', { cls: 'monday-sidebar-item-wrapper' });
                const itemEl = itemWrapper.createEl('div', { cls: 'monday-sidebar-item monday-sidebar-item-clickable' });

                // Expand/collapse arrow for items with subitems
                const hasSubitems = item.subitems && item.subitems.length > 0;
                const isExpanded = this.expandedItems.has(item.id);

                if (hasSubitems) {
                    const expandBtn = itemEl.createEl('span', {
                        cls: `monday-expand-btn ${isExpanded ? 'expanded' : ''}`,
                        text: isExpanded ? '▼' : '▶'
                    });
                    expandBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (this.expandedItems.has(item.id)) {
                            this.expandedItems.delete(item.id);
                        } else {
                            this.expandedItems.add(item.id);
                        }
                        // Re-render the filtered items
                        const itemsContainer = this.containerEl.querySelector('.monday-sidebar-items') as HTMLElement;
                        if (itemsContainer && this.currentBoardData) {
                            this.renderFilteredItems(itemsContainer, this.currentBoardData);
                        }
                    });
                } else {
                    // No subtasks - show simple bullet icon
                    itemEl.createEl('span', {
                        cls: 'monday-no-subtasks-icon',
                        text: '○'
                    });
                }

                // Item name (clickable to create note)
                const nameEl = itemEl.createEl('span', { text: item.name, cls: 'monday-sidebar-item-name' });
                nameEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    void this.handleItemClick(item, boardData);
                });

                // Actions container
                const actionsEl = itemEl.createEl('div', { cls: 'monday-item-actions' });

                // Find status column and its info
                const statusColumn = boardData.columns.find(c => c.type === 'status');
                const statusColValue = statusColumn ? item.column_values.find(cv => cv.id === statusColumn.id) : null;
                const currentStatus = statusColValue?.text || '';

                // Quick status dropdown (if enabled in settings)
                if (this.plugin.settings.showStatusDropdown && statusColumn && this.availableStatuses.has(statusColumn.id)) {
                    const statusOptions = this.availableStatuses.get(statusColumn.id) || [];
                    const statusDropdown = actionsEl.createEl('select', { cls: 'monday-status-dropdown' });
                    statusDropdown.title = 'Change status';

                    for (const status of statusOptions) {
                        const opt = statusDropdown.createEl('option', { text: status, value: status });
                        if (status === currentStatus) {
                            opt.selected = true;
                        }
                    }

                    statusDropdown.addEventListener('change', (e) => {
                        e.stopPropagation();
                        const newStatus = (e.target as HTMLSelectElement).value;
                        if (newStatus !== currentStatus && this.selectedBoardId) {
                            void this.changeItemStatus(item, statusColumn.id, newStatus);
                        }
                    });

                    statusDropdown.addEventListener('click', (e) => e.stopPropagation());
                }

                // Status badge (visual indicator)
                if (currentStatus) {
                    const statusBadge = actionsEl.createEl('span', {
                        text: currentStatus,
                        cls: 'monday-sidebar-status'
                    });
                    try {
                        const valueObj = statusColValue?.value ? JSON.parse(statusColValue.value) : null;
                        if (valueObj?.label_style?.color) {
                            statusBadge.style.backgroundColor = valueObj.label_style.color;
                        }
                    } catch {
                        // Use default
                    }
                }

                // Context menu on right-click
                itemEl.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.showItemContextMenu(e, item, boardData);
                });

                // Render subitems if expanded
                if (hasSubitems && isExpanded && item.subitems) {
                    const subitemsContainer = itemWrapper.createEl('div', { cls: 'monday-subitems-container' });

                    let filteredSubitemsCount = 0;

                    for (const subitem of item.subitems) {
                        // Apply status filter to subitems
                        // Note: Subitems have their own column IDs, so we search all column_values
                        // for status-like content (those with index property in JSON value)
                        if (this.statusFilter.selected.size > 0) {
                            let subitemStatus = '';

                            // Find status column value by looking for one with index property (status indicator)
                            for (const cv of subitem.column_values) {
                                if (cv.value) {
                                    try {
                                        const valueObj = JSON.parse(cv.value);
                                        // Status columns have an 'index' property
                                        if (typeof valueObj?.index === 'number') {
                                            subitemStatus = cv.text || '';
                                            break;
                                        }
                                    } catch {
                                        // Not JSON, skip
                                    }
                                }
                            }

                            const isSelected = this.statusFilter.selected.has(subitemStatus);
                            const shouldShow = this.statusFilter.mode === 'include' ? isSelected : !isSelected;
                            if (!shouldShow) continue;
                        }

                        filteredSubitemsCount++;
                        const subitemEl = subitemsContainer.createEl('div', { cls: 'monday-subitem monday-subitem-clickable' });

                        subitemEl.createEl('span', { text: '└─', cls: 'monday-subitem-prefix' });
                        const subitemNameEl = subitemEl.createEl('span', { text: subitem.name, cls: 'monday-subitem-name' });

                        // Click handler to create note for subitem
                        subitemNameEl.addEventListener('click', (e) => {
                            e.stopPropagation();
                            void this.handleSubitemClick(subitem, item, boardData);
                        });

                        // Context menu for subitem (right-click)
                        subitemEl.addEventListener('contextmenu', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            this.showSubitemContextMenu(e, subitem, item, boardData);
                        });

                        // Status badge for subitem - find by index property (status indicator)
                        for (const cv of subitem.column_values) {
                            if (cv.value && cv.text) {
                                try {
                                    const valueObj = JSON.parse(cv.value);
                                    if (typeof valueObj?.index === 'number') {
                                        const statusBadge = subitemEl.createEl('span', {
                                            text: cv.text,
                                            cls: 'monday-subitem-status'
                                        });
                                        if (valueObj.label_style?.color) {
                                            statusBadge.style.backgroundColor = valueObj.label_style.color;
                                        }
                                        break;
                                    }
                                } catch {
                                    // Not JSON, skip
                                }
                            }
                        }
                    }

                    // Show hint if all subitems were filtered out
                    if (filteredSubitemsCount === 0) {
                        const hintEl = subitemsContainer.createEl('div', { cls: 'monday-subitem monday-subitems-filtered-hint' });
                        hintEl.createEl('span', { text: '└─', cls: 'monday-subitem-prefix' });
                        hintEl.createEl('span', { text: `(${item.subitems.length} subtasks hidden by filter)`, cls: 'monday-subitem-hint-text' });
                    }

                    // Add subtask button
                    const addSubtaskBtn = subitemsContainer.createEl('div', { cls: 'monday-add-subtask' });
                    addSubtaskBtn.createEl('span', { text: '└─', cls: 'monday-subitem-prefix' });
                    addSubtaskBtn.createEl('span', { text: '+ add subtask', cls: 'monday-add-subtask-text' });
                    addSubtaskBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        new CreateSubtaskModal(this.app, item.name, (subtaskName) => {
                            if (subtaskName) {
                                void this.createSubtask(item, subtaskName);
                            }
                        }).open();
                    });
                }
            }
        }

        // Item count
        container.createEl('div', {
            text: `Showing ${filteredItems.length} of ${boardData.items.length} items`,
            cls: 'monday-sidebar-item-count'
        });
    }

    private async handleItemClick(item: Item, boardData: BoardData) {
        const plugin = this.plugin;
        const app = this.app;

        // Generate note path
        const noteName = this.generateNoteName(item, boardData);
        const noteFolder = plugin.settings.noteFolder || 'Monday';
        const notePath = normalizePath(`${noteFolder}/${noteName}.md`);

        // Check if file exists
        const existingFile = app.vault.getAbstractFileByPath(notePath);

        if (existingFile && existingFile instanceof TFile) {
            // File exists - show modal
            new DuplicateNoteModal(app, notePath, (action) => {
                if (action === 'open') {
                    void app.workspace.openLinkText(notePath, '', false);
                } else if (action === 'create') {
                    // Create with incremented name
                    let counter = 1;
                    let newPath = notePath;
                    while (app.vault.getAbstractFileByPath(newPath)) {
                        newPath = normalizePath(`${noteFolder}/${noteName} (${counter}).md`);
                        counter++;
                    }
                    void this.createNoteForItem(item, boardData, newPath);
                }
            }).open();
        } else {
            // Create the note
            await this.createNoteForItem(item, boardData, notePath);
        }
    }

    private generateNoteName(item: Item, boardData: BoardData): string {
        const template = this.plugin.settings.noteNameTemplate || '{name}';
        const boardName = boardData.name || 'Unknown Board';
        const groupName = item.group?.title || 'No Group';

        // Sanitise for filename
        const sanitise = (str: string) => str.replace(/[\\/:*?"<>|]/g, '-');

        return template
            .replace('{name}', sanitise(item.name))
            .replace('{board}', sanitise(boardName))
            .replace('{group}', sanitise(groupName))
            .replace('{id}', item.id);
    }

    private async createNoteForItem(item: Item, boardData: BoardData, notePath: string) {
        const app = this.app;
        const plugin = this.plugin;

        // Ensure folder exists
        const folderPath = notePath.substring(0, notePath.lastIndexOf('/'));
        if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
            await app.vault.createFolder(folderPath);
        }

        // Get item details
        const statusCol = item.column_values.find(cv => {
            const col = boardData.columns.find(c => c.id === cv.id);
            return col?.type === 'status';
        });
        const dateCol = item.column_values.find(cv => {
            const col = boardData.columns.find(c => c.id === cv.id);
            return col?.type === 'date';
        });
        const personCol = item.column_values.find(cv => {
            const col = boardData.columns.find(c => c.id === cv.id);
            return col?.type === 'person' || col?.type === 'people';
        });

        // Find board URL
        const board = plugin.settings.cachedBoards.find(b => b.id === this.selectedBoardId);

        // Build frontmatter
        const frontmatter: Record<string, string | string[]> = {
            title: item.name,
            monday_id: item.id,
            monday_board: boardData.name,
            monday_board_id: this.selectedBoardId || '',
            status: statusCol?.text || '',
            group: item.group?.title || '',
            created: new Date().toISOString().split('T')[0],
            tags: ['monday']
        };

        if (dateCol?.text) {
            frontmatter['due_date'] = dateCol.text;
        }
        if (personCol?.text) {
            frontmatter['assigned'] = personCol.text;
        }

        // Build note content
        let content = '---\n';
        for (const [key, value] of Object.entries(frontmatter)) {
            if (Array.isArray(value)) {
                content += `${key}:\n`;
                for (const v of value) {
                    content += `  - ${v}\n`;
                }
            } else if (value) {
                content += `${key}: "${value}"\n`;
            }
        }
        content += '---\n\n';
        content += `# ${item.name}\n\n`;
        content += `## Details\n\n`;
        content += `- **Board:** ${boardData.name}\n`;
        content += `- **Group:** ${item.group?.title || 'None'}\n`;
        content += `- **Status:** ${statusCol?.text || 'None'}\n`;
        if (dateCol?.text) {
            content += `- **Due Date:** ${dateCol.text}\n`;
        }
        if (personCol?.text) {
            content += `- **Assigned:** ${personCol.text}\n`;
        }

        // Add subtasks section with links
        if (item.subitems && item.subitems.length > 0) {
            content += `\n## Subtasks\n\n`;
            for (const subitem of item.subitems) {
                const subitemStatus = subitem.column_values.find(cv => {
                    const col = boardData.columns.find(c => c.id === cv.id);
                    return col?.type === 'status';
                });
                const statusText = subitemStatus?.text ? ` - ${subitemStatus.text}` : '';
                const subitemNoteName = this.generateSubitemNoteName(subitem, item, boardData);
                content += `- [ ] [[${subitemNoteName}]]${statusText}\n`;
            }
        }

        content += `\n## Notes\n\n`;

        // Create the file
        const file = await app.vault.create(notePath, content);
        await app.workspace.openLinkText(notePath, '', false);
        new Notice(`Created note: ${file.basename}`);
    }

    private async handleSubitemClick(subitem: Subitem, parentItem: Item, boardData: BoardData) {
        const plugin = this.plugin;
        const app = this.app;

        // Generate note path using template settings
        const noteName = this.generateSubitemNoteName(subitem, parentItem, boardData);
        const noteFolder = plugin.settings.noteFolder || 'Monday';
        const notePath = normalizePath(`${noteFolder}/${noteName}.md`);

        // Check if file exists
        const existingFile = app.vault.getAbstractFileByPath(notePath);

        if (existingFile && existingFile instanceof TFile) {
            // File exists - open it
            await app.workspace.openLinkText(notePath, '', false);
        } else {
            // Create the note
            await this.createNoteForSubitem(subitem, parentItem, boardData, notePath);
        }
    }

    private generateSubitemNoteName(subitem: Subitem, parentItem: Item, boardData: BoardData): string {
        const template = this.plugin.settings.noteNameTemplate || '{name}';
        const boardName = boardData.name || 'Unknown Board';
        const groupName = parentItem.group?.title || 'No Group';

        // Sanitise for filename
        const sanitise = (str: string) => str.replace(/[\\/:*?"<>|]/g, '-');

        return template
            .replace('{name}', sanitise(subitem.name))
            .replace('{board}', sanitise(boardName))
            .replace('{group}', sanitise(groupName))
            .replace('{id}', subitem.id);
    }

    private async createNoteForSubitem(subitem: Subitem, parentItem: Item, boardData: BoardData, notePath: string) {
        const app = this.app;
        const plugin = this.plugin;

        // Ensure folder exists
        const folderPath = notePath.substring(0, notePath.lastIndexOf('/'));
        if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
            await app.vault.createFolder(folderPath);
        }

        // Get subitem status
        const statusCol = subitem.column_values.find(cv => {
            const col = boardData.columns.find(c => c.id === cv.id);
            return col?.type === 'status';
        });

        // Build frontmatter
        const frontmatter: Record<string, string | string[]> = {
            title: subitem.name,
            monday_id: subitem.id,
            monday_parent_id: parentItem.id,
            monday_parent: parentItem.name,
            monday_board: boardData.name,
            monday_board_id: this.selectedBoardId || '',
            status: statusCol?.text || '',
            type: 'subtask',
            created: new Date().toISOString().split('T')[0],
            tags: ['monday', 'subtask']
        };

        // Build note content
        let content = '---\n';
        for (const [key, value] of Object.entries(frontmatter)) {
            if (Array.isArray(value)) {
                content += `${key}:\n`;
                for (const v of value) {
                    content += `  - ${v}\n`;
                }
            } else if (value) {
                content += `${key}: "${value}"\n`;
            }
        }
        content += '---\n\n';
        content += `# ${subitem.name}\n\n`;

        // Link to parent task (use template for parent note name)
        const parentNoteName = this.generateNoteName(parentItem, boardData);
        content += `## Parent Task\n\n`;
        content += `[[${parentNoteName}]]\n\n`;

        content += `## Details\n\n`;
        content += `- **Board:** ${boardData.name}\n`;
        content += `- **Parent:** ${parentItem.name}\n`;
        content += `- **Status:** ${statusCol?.text || 'None'}\n`;

        // Add sibling subtasks (other subtasks of the same parent)
        if (parentItem.subitems && parentItem.subitems.length > 1) {
            content += `\n## Related Subtasks\n\n`;
            for (const sibling of parentItem.subitems) {
                if (sibling.id !== subitem.id) {
                    const siblingStatus = sibling.column_values.find(cv => {
                        const col = boardData.columns.find(c => c.id === cv.id);
                        return col?.type === 'status';
                    });
                    const statusText = siblingStatus?.text ? ` - ${siblingStatus.text}` : '';
                    const siblingNoteName = this.generateSubitemNoteName(sibling, parentItem, boardData);
                    content += `- [[${siblingNoteName}]]${statusText}\n`;
                }
            }
        }

        content += `\n## Notes\n\n`;

        // Create the file
        const file = await app.vault.create(notePath, content);
        await app.workspace.openLinkText(notePath, '', false);
        new Notice(`Created note: ${file.basename}`);
    }

    private showItemContextMenu(event: MouseEvent, item: Item, boardData: BoardData) {
        const menu = new Menu();

        // Create note option
        menu.addItem((menuItem) => {
            menuItem
                .setTitle('Create note')
                .setIcon('file-plus')
                .onClick(() => {
                    void this.handleItemClick(item, boardData);
                });
        });

        menu.addSeparator();

        // Status change submenu
        const statusColumn = boardData.columns.find(c => c.type === 'status');
        if (statusColumn && this.availableStatuses.has(statusColumn.id)) {
            const statusOptions = this.availableStatuses.get(statusColumn.id) || [];
            const currentStatusValue = item.column_values.find(cv => cv.id === statusColumn.id);
            const currentStatus = currentStatusValue?.text || '';

            menu.addItem((menuItem) => {
                menuItem
                    .setTitle('Change status')
                    .setIcon('check-circle');

                // Add submenu items for each status
                const submenu = (menuItem as unknown as MenuItemWithSubmenu).setSubmenu();
                for (const status of statusOptions) {
                    submenu.addItem((subItem) => {
                        subItem
                            .setTitle(status)
                            .setChecked(status === currentStatus)
                            .onClick(() => {
                                if (status !== currentStatus) {
                                    void this.changeItemStatus(item, statusColumn.id, status);
                                }
                            });
                    });
                }
            });
        }

        // Add comment option
        menu.addItem((menuItem) => {
            menuItem
                .setTitle('Add comment')
                .setIcon('message-square')
                .onClick(() => {
                    new AddCommentModal(this.app, item.name, (comment) => {
                        if (comment) {
                            void this.addItemComment(item, comment);
                        }
                    }).open();
                });
        });

        // Assign person option
        const peopleColumn = boardData.columns.find(c => c.type === 'people' || c.type === 'multiple-person');
        if (peopleColumn) {
            const currentAssignees = this.getItemAssignees(item, [peopleColumn]);
            menu.addItem((menuItem) => {
                menuItem
                    .setTitle(currentAssignees.length > 0 ? 'Reassign' : 'Assign person')
                    .setIcon('user-plus')
                    .onClick(() => {
                        new AssignPersonModal(
                            this.app,
                            this.plugin,
                            item.name,
                            currentAssignees,
                            (userIds) => {
                                if (userIds !== null && this.selectedBoardId) {
                                    void this.assignPersonToItem(item, boardData, peopleColumn.id, userIds);
                                }
                            }
                        ).open();
                    });
            });
        }

        // Add subtask option
        menu.addItem((menuItem) => {
            menuItem
                .setTitle('Add subtask')
                .setIcon('list-plus')
                .onClick(() => {
                    new CreateSubtaskModal(this.app, item.name, (subtaskName) => {
                        if (subtaskName) {
                            void this.createSubtask(item, subtaskName);
                        }
                    }).open();
                });
        });

        menu.showAtMouseEvent(event);
    }

    private showSubitemContextMenu(event: MouseEvent, subitem: Subitem, parentItem: Item, boardData: BoardData) {
        const menu = new Menu();

        // Create note option
        menu.addItem((menuItem) => {
            menuItem
                .setTitle('Create note')
                .setIcon('file-plus')
                .onClick(() => {
                    void this.handleSubitemClick(subitem, parentItem, boardData);
                });
        });

        menu.addSeparator();

        // Status change submenu - find status column by index property
        let statusColumnId = '';
        let currentStatus = '';
        for (const cv of subitem.column_values) {
            if (cv.value) {
                try {
                    const parsed = JSON.parse(cv.value);
                    if (typeof parsed.index === 'number') {
                        statusColumnId = cv.id;
                        currentStatus = cv.text || '';
                        break;
                    }
                } catch {
                    // Not a status column
                }
            }
        }

        if (statusColumnId) {
            // Get available statuses from parent board's status column
            const statusColumn = boardData.columns.find(c => c.type === 'status');
            const statusOptions = statusColumn ? (this.availableStatuses.get(statusColumn.id) || []) : [];

            if (statusOptions.length > 0) {
                menu.addItem((menuItem) => {
                    menuItem
                        .setTitle('Change status')
                        .setIcon('check-circle');

                    const submenu = (menuItem as unknown as MenuItemWithSubmenu).setSubmenu();
                    for (const status of statusOptions) {
                        submenu.addItem((subItem) => {
                            subItem
                                .setTitle(status)
                                .setChecked(status === currentStatus)
                                .onClick(() => {
                                    if (status !== currentStatus) {
                                        void this.changeSubitemStatus(subitem, parentItem, statusColumnId, status);
                                    }
                                });
                        });
                    }
                });
            }
        }

        // Assign person option - find current assignees
        const currentAssignees: string[] = [];
        for (const cv of subitem.column_values) {
            if (cv.value && cv.text) {
                try {
                    const parsed = JSON.parse(cv.value);
                    if (parsed.personsAndTeams !== undefined && cv.text) {
                        const names = cv.text.split(',').map((n: string) => n.trim()).filter((n: string) => n);
                        currentAssignees.push(...names);
                    }
                } catch {
                    // Not a people column
                }
            }
        }

        menu.addItem((menuItem) => {
            menuItem
                .setTitle(currentAssignees.length > 0 ? 'Reassign' : 'Assign person')
                .setIcon('user-plus')
                .onClick(() => {
                    new AssignPersonModal(
                        this.app,
                        this.plugin,
                        subitem.name,
                        currentAssignees,
                        (userIds) => {
                            if (userIds !== null) {
                                void this.assignPersonToSubitem(subitem, parentItem, boardData, userIds);
                            }
                        }
                    ).open();
                });
        });

        menu.showAtMouseEvent(event);
    }

    private async changeItemStatus(item: Item, columnId: string, newStatus: string) {
        if (!this.selectedBoardId) return;

        try {
            new Notice(`Changing status to "${newStatus}"...`);
            await this.plugin.apiClient.changeItemStatus(
                this.selectedBoardId,
                item.id,
                columnId,
                newStatus
            );
            new Notice(`Status updated to "${newStatus}"`);

            // Refresh the board data to show the update
            this.currentBoardData = null;
            const container = this.containerEl.children[1];
            await this.loadAndRenderBoard(container);
        } catch (error) {
            new Notice(`Failed to change status: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async changeSubitemStatus(subitem: Subitem, parentItem: Item, columnId: string, newStatus: string) {
        try {
            new Notice(`Changing status to "${newStatus}"...`);
            await this.plugin.apiClient.changeSubitemStatus(subitem.id, columnId, newStatus);
            new Notice(`Status updated to "${newStatus}"`);

            // Refresh the board data
            this.currentBoardData = null;
            await this.loadAndRenderBoard(this.containerEl.children[1] as HTMLElement);
        } catch (error) {
            new Notice(`Failed to change status: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async addItemComment(item: Item, comment: string) {
        try {
            new Notice('Adding comment...');
            await this.plugin.apiClient.addItemUpdate(item.id, comment);
            new Notice('Comment added successfully');
        } catch (error) {
            new Notice(`Failed to add comment: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async createSubtask(item: Item, subtaskName: string) {
        try {
            new Notice('Creating subtask...');
            const result = await this.plugin.apiClient.createSubitem(item.id, subtaskName);
            if (result) {
                new Notice(`Subtask created: ${result.name}`);
                // Expand the item to show the new subtask
                this.expandedItems.add(item.id);
                // Refresh to show the new subtask
                await this.loadAndRenderBoard(this.containerEl.children[1] as HTMLElement);
            } else {
                new Notice('Failed to create subtask');
            }
        } catch (error) {
            new Notice(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async assignPersonToItem(item: Item, boardData: BoardData, columnId: string, userIds: number[]) {
        if (!this.selectedBoardId) return;

        try {
            new Notice('Updating assignment...');
            await this.plugin.apiClient.assignPerson(this.selectedBoardId, item.id, columnId, userIds);
            new Notice(userIds.length > 0 ? 'Person assigned' : 'Assignment cleared');

            // Refresh the board data
            this.currentBoardData = null;
            await this.loadAndRenderBoard(this.containerEl.children[1] as HTMLElement);
        } catch (error) {
            new Notice(`Failed to assign: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async assignPersonToSubitem(subitem: Subitem, parentItem: Item, boardData: BoardData, userIds: number[]) {
        try {
            // Find people column - subitems may have different column IDs
            // We'll try to find any people column in the subitem's values
            let peopleColumnId = '';
            for (const cv of subitem.column_values) {
                if (cv.value) {
                    try {
                        const parsed = JSON.parse(cv.value);
                        if (parsed.personsAndTeams !== undefined) {
                            peopleColumnId = cv.id;
                            break;
                        }
                    } catch {
                        // Not a people column
                    }
                }
            }

            // Fall back to finding by board column type if no value found
            if (!peopleColumnId) {
                const peopleCol = boardData.columns.find(c => c.type === 'people' || c.type === 'multiple-person');
                if (peopleCol) peopleColumnId = peopleCol.id;
            }

            if (!peopleColumnId) {
                new Notice('Could not find people column');
                return;
            }

            new Notice('Updating assignment...');
            await this.plugin.apiClient.assignPersonToSubitem(parentItem.id, subitem.id, peopleColumnId, userIds);
            new Notice(userIds.length > 0 ? 'Person assigned' : 'Assignment cleared');

            // Refresh
            this.currentBoardData = null;
            await this.loadAndRenderBoard(this.containerEl.children[1] as HTMLElement);
        } catch (error) {
            new Notice(`Failed to assign: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async refreshBoards() {
        try {
            new Notice('Refreshing Monday.com boards...');
            const boards = await this.plugin.apiClient.getBoards();
            this.plugin.settings.cachedBoards = boards;
            this.plugin.settings.lastSync = Date.now();
            await this.plugin.saveSettings();
            new Notice(`Loaded ${boards.length} boards`);
            await this.render();
        } catch (error) {
            new Notice(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private getItemAssignees(item: Item, peopleColumns: Column[]): string[] {
        const assignees: string[] = [];

        for (const col of peopleColumns) {
            const colValue = item.column_values.find(cv => cv.id === col.id);
            if (colValue?.value) {
                try {
                    const parsed = JSON.parse(colValue.value);
                    if (parsed.personsAndTeams && Array.isArray(parsed.personsAndTeams)) {
                        if (colValue.text) {
                            const names = colValue.text.split(',').map((n: string) => n.trim()).filter((n: string) => n);
                            assignees.push(...names);
                        }
                    }
                } catch {
                    if (colValue.text) {
                        const names = colValue.text.split(',').map((n: string) => n.trim()).filter((n: string) => n);
                        assignees.push(...names);
                    }
                }
            }
        }

        return [...new Set(assignees)];
    }

    // Public method to set board from other views (for sync)
    setBoard(boardId: string) {
        if (this.selectedBoardId === boardId) return; // Already on this board
        this.selectedBoardId = boardId;
        this.statusFilter = { selected: new Set(), mode: 'include' };
        this.groupFilter = { selected: new Set(), mode: 'include' };
        this.personFilter = null;
        this.currentBoardData = null;
        void this.render();
    }

    // Public method to set person filter from Team View
    setPersonFilter(personName: string | null) {
        this.personFilter = personName;
        if (this.currentBoardData) {
            const container = this.containerEl.children[1] as HTMLElement;
            const itemsContainer = container.querySelector('.monday-sidebar-items') as HTMLElement;
            if (itemsContainer) {
                this.renderFilteredItems(itemsContainer, this.currentBoardData);
            }
            // Update the person filter indicator
            this.updatePersonFilterIndicator(container);
        }
    }

    private updatePersonFilterIndicator(container: HTMLElement) {
        // Remove existing indicator
        const existing = container.querySelector('.monday-person-filter-indicator');
        if (existing) existing.remove();

        if (this.personFilter) {
            const filtersContainer = container.querySelector('.monday-sidebar-filters') as HTMLElement;
            if (filtersContainer) {
                const indicator = filtersContainer.createEl('div', { cls: 'monday-person-filter-indicator' });
                indicator.createEl('span', { text: `Filtered: ${this.personFilter}`, cls: 'monday-person-filter-text' });
                const clearBtn = indicator.createEl('span', { text: '✕', cls: 'monday-person-filter-clear' });
                clearBtn.addEventListener('click', () => {
                    this.setPersonFilter(null);
                });
            }
        }
    }

    async onClose() {
        // Cleanup if needed
    }
}

// ============================================================================
// Team Summary View
// ============================================================================

class MondayTeamView extends ItemView {
    private plugin: MondayIntegrationPlugin;
    private selectedBoardId: string = '';

    constructor(leaf: WorkspaceLeaf, plugin: MondayIntegrationPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return MONDAY_TEAM_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Monday team';
    }

    getIcon(): string {
        return 'users';
    }

    async onOpen() {
        // Use shared board selection, or fall back to default board
        if (!this.selectedBoardId) {
            this.selectedBoardId = this.plugin.currentBoardId || this.plugin.settings.defaultBoardId || '';
        }
        await this.render();
    }

    async render() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('monday-team-sidebar');

        // Check for API token
        if (!this.plugin.settings.apiToken) {
            const errorEl = container.createEl('div', { cls: 'monday-sidebar-error' });
            errorEl.createEl('p', { text: 'API token not configured.' });
            const settingsBtn = errorEl.createEl('button', { text: 'Open settings' });
            settingsBtn.addEventListener('click', () => {
                // @ts-ignore - Obsidian internal API
                this.app.setting.open();
                // @ts-ignore
                this.app.setting.openTabById('monday-integration');
            });
            return;
        }

        // Header
        const headerEl = container.createEl('div', { cls: 'monday-sidebar-header' });
        headerEl.createEl('h4', { text: 'Team summary' });

        const refreshBtn = headerEl.createEl('button', { cls: 'monday-sidebar-refresh' });
        refreshBtn.setText('↻');
        refreshBtn.title = 'Refresh';
        refreshBtn.addEventListener('click', () => void this.render());

        // Board selector
        const selectorEl = container.createEl('div', { cls: 'monday-board-selector' });
        const selectEl = selectorEl.createEl('select', { cls: 'monday-board-select' });

        const defaultOption = selectEl.createEl('option', { text: 'Select a board...', value: '' });
        defaultOption.disabled = true;
        defaultOption.selected = !this.selectedBoardId;

        for (const board of this.plugin.settings.cachedBoards) {
            const option = selectEl.createEl('option', {
                text: board.name,
                value: board.id
            });
            if (board.id === this.selectedBoardId) {
                option.selected = true;
            }
        }

        selectEl.addEventListener('change', (e) => {
            const boardId = (e.target as HTMLSelectElement).value;
            this.selectedBoardId = boardId;
            void this.loadAndRenderTeamStats(container as HTMLElement);
            // Sync to main view
            this.plugin.syncBoardSelection(boardId, 'team');
        });

        // Team stats container
        container.createEl('div', { cls: 'monday-team-stats' });

        if (this.selectedBoardId) {
            await this.loadAndRenderTeamStats(container as HTMLElement);
        } else if (this.plugin.settings.cachedBoards.length === 0) {
            const statsContainer = container.querySelector('.monday-team-stats') as HTMLElement;
            statsContainer.createEl('p', { text: 'Click refresh in main view to load boards.', cls: 'monday-sidebar-hint' });
        }
    }

    private async loadAndRenderTeamStats(container: HTMLElement) {
        const statsContainer = container.querySelector('.monday-team-stats') as HTMLElement;
        if (!statsContainer) return;

        statsContainer.empty();

        // Show loading
        const loadingEl = statsContainer.createEl('div', { cls: 'monday-loading' });
        loadingEl.createEl('div', { cls: 'monday-spinner' });
        loadingEl.createEl('span', { text: 'Loading team data...', cls: 'monday-loading-text' });

        try {
            const boardData = await this.plugin.apiClient.getBoardData(this.selectedBoardId, 500);
            statsContainer.empty();

            if (!boardData || boardData.items.length === 0) {
                statsContainer.createEl('p', { text: 'No items found.', cls: 'monday-sidebar-hint' });
                return;
            }

            // Aggregate team stats
            const teamStats = this.aggregateTeamStats(boardData);

            if (teamStats.length === 0) {
                statsContainer.createEl('p', { text: 'No assigned tasks found.', cls: 'monday-sidebar-hint' });
                return;
            }

            // Render team stats
            this.renderTeamStats(statsContainer, teamStats);

        } catch (error) {
            statsContainer.empty();
            statsContainer.createEl('p', {
                text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                cls: 'monday-sidebar-error'
            });
        }
    }

    private aggregateTeamStats(boardData: BoardData): TeamMemberStats[] {
        const statsMap = new Map<string, TeamMemberStats>();

        // Find people column(s) and status column(s)
        const peopleColumns = boardData.columns.filter(c => c.type === 'people' || c.type === 'multiple-person');
        const statusColumns = boardData.columns.filter(c => c.type === 'status');
        const dateColumns = boardData.columns.filter(c => c.type === 'date' || c.type === 'timeline');

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        for (const item of boardData.items) {
            // Get assignees for this item
            const assignees = this.getAssignees(item, peopleColumns);
            if (assignees.length === 0) continue;

            // Get status
            const status = this.getItemStatus(item, statusColumns);
            const isDone = status.toLowerCase().includes('done');
            const isWorkingOnIt = status.toLowerCase().includes('working') ||
                                   status.toLowerCase().includes('in progress') ||
                                   status.toLowerCase().includes('active');

            // Check if overdue (has due date, not done, past due)
            const isOverdue = !isDone && this.isItemOverdue(item, dateColumns, today);

            // Update stats for each assignee
            for (const assignee of assignees) {
                if (!statsMap.has(assignee)) {
                    statsMap.set(assignee, {
                        name: assignee,
                        workingOnIt: 0,
                        done: 0,
                        overdue: 0
                    });
                }

                const stats = statsMap.get(assignee)!;
                if (isDone) {
                    stats.done++;
                } else if (isWorkingOnIt) {
                    stats.workingOnIt++;
                }
                if (isOverdue) {
                    stats.overdue++;
                }
            }
        }

        // Sort by name
        return Array.from(statsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    private getAssignees(item: Item, peopleColumns: Column[]): string[] {
        const assignees: string[] = [];

        for (const col of peopleColumns) {
            const colValue = item.column_values.find(cv => cv.id === col.id);
            if (colValue?.value) {
                try {
                    const parsed = JSON.parse(colValue.value);
                    // People column format: { personsAndTeams: [{ id, kind }] }
                    if (parsed.personsAndTeams && Array.isArray(parsed.personsAndTeams)) {
                        // Use the text field which contains names
                        if (colValue.text) {
                            const names = colValue.text.split(',').map((n: string) => n.trim()).filter((n: string) => n);
                            assignees.push(...names);
                        }
                    }
                } catch {
                    // If parsing fails, try using text directly
                    if (colValue.text) {
                        const names = colValue.text.split(',').map((n: string) => n.trim()).filter((n: string) => n);
                        assignees.push(...names);
                    }
                }
            }
        }

        return [...new Set(assignees)]; // Remove duplicates
    }

    private getItemStatus(item: Item, statusColumns: Column[]): string {
        for (const col of statusColumns) {
            const colValue = item.column_values.find(cv => cv.id === col.id);
            if (colValue?.text) {
                return colValue.text;
            }
        }
        return '';
    }

    private isItemOverdue(item: Item, dateColumns: Column[], today: Date): boolean {
        for (const col of dateColumns) {
            const colValue = item.column_values.find(cv => cv.id === col.id);
            if (colValue?.value) {
                try {
                    const parsed = JSON.parse(colValue.value);
                    // Date column format: { date: "YYYY-MM-DD" }
                    // Timeline format: { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
                    const dateStr = parsed.date || parsed.to;
                    if (dateStr) {
                        const dueDate = new Date(dateStr);
                        dueDate.setHours(0, 0, 0, 0);
                        if (dueDate < today) {
                            return true;
                        }
                    }
                } catch {
                    // Skip if parsing fails
                }
            }
        }
        return false;
    }

    private renderTeamStats(container: HTMLElement, stats: TeamMemberStats[]) {
        for (const member of stats) {
            const memberEl = container.createEl('div', { cls: 'monday-team-member monday-team-member-clickable' });
            memberEl.title = `Click to filter by ${member.name}`;

            // Click handler to filter main view
            memberEl.addEventListener('click', () => {
                this.filterMainViewByPerson(member.name);
            });

            // Name
            memberEl.createEl('span', { text: member.name, cls: 'monday-team-member-name' });

            // Stats badges container
            const badgesEl = memberEl.createEl('div', { cls: 'monday-team-badges' });

            // Working on it badge (blue/orange)
            if (member.workingOnIt > 0) {
                const workingBadge = badgesEl.createEl('span', {
                    text: String(member.workingOnIt),
                    cls: 'monday-team-badge monday-team-badge-working'
                });
                workingBadge.title = 'Working on it';
            }

            // Done badge (green)
            if (member.done > 0) {
                const doneBadge = badgesEl.createEl('span', {
                    text: String(member.done),
                    cls: 'monday-team-badge monday-team-badge-done'
                });
                doneBadge.title = 'Done';
            }

            // Overdue badge (red)
            if (member.overdue > 0) {
                const overdueBadge = badgesEl.createEl('span', {
                    text: String(member.overdue),
                    cls: 'monday-team-badge monday-team-badge-overdue'
                });
                overdueBadge.title = 'Overdue';
            }

            // Show dash if no stats
            if (member.workingOnIt === 0 && member.done === 0 && member.overdue === 0) {
                badgesEl.createEl('span', { text: '-', cls: 'monday-team-no-tasks' });
            }
        }

        // Summary row
        const totalWorking = stats.reduce((sum, s) => sum + s.workingOnIt, 0);
        const totalDone = stats.reduce((sum, s) => sum + s.done, 0);
        const totalOverdue = stats.reduce((sum, s) => sum + s.overdue, 0);

        const summaryEl = container.createEl('div', { cls: 'monday-team-summary' });
        summaryEl.createEl('span', { text: 'Total:', cls: 'monday-team-summary-label' });

        const summaryBadges = summaryEl.createEl('div', { cls: 'monday-team-badges' });

        const workingSummary = summaryBadges.createEl('span', {
            text: String(totalWorking),
            cls: 'monday-team-badge monday-team-badge-working'
        });
        workingSummary.title = 'Total working';

        const doneSummary = summaryBadges.createEl('span', {
            text: String(totalDone),
            cls: 'monday-team-badge monday-team-badge-done'
        });
        doneSummary.title = 'Total done';

        const overdueSummary = summaryBadges.createEl('span', {
            text: String(totalOverdue),
            cls: 'monday-team-badge monday-team-badge-overdue'
        });
        overdueSummary.title = 'Total overdue';
    }

    // Public method to set board from other views (for sync)
    setBoard(boardId: string) {
        if (this.selectedBoardId === boardId) return; // Already on this board
        this.selectedBoardId = boardId;
        void this.render();
    }

    private filterMainViewByPerson(personName: string) {
        const { workspace } = this.app;

        // Find the main Monday view
        const mondayLeaves = workspace.getLeavesOfType(MONDAY_VIEW_TYPE);
        if (mondayLeaves.length > 0) {
            const mondayView = mondayLeaves[0].view as MondayView;
            mondayView.setPersonFilter(personName);
            void workspace.revealLeaf(mondayLeaves[0]);
            new Notice(`Filtered by: ${personName}`);
        } else {
            // Open the main view first, then filter
            void this.plugin.activateView().then(() => {
                const leaves = workspace.getLeavesOfType(MONDAY_VIEW_TYPE);
                if (leaves.length > 0) {
                    const mondayView = leaves[0].view as MondayView;
                    // Wait a moment for the view to load
                    setTimeout(() => {
                        mondayView.setPersonFilter(personName);
                        new Notice(`Filtered by: ${personName}`);
                    }, 500);
                }
            });
        }
    }

    async onClose() {
        // Cleanup if needed
    }
}

// ============================================================================
// Duplicate Note Modal
// ============================================================================

class DuplicateNoteModal extends Modal {
    private notePath: string;
    private callback: (action: 'open' | 'create') => void;

    constructor(app: App, notePath: string, callback: (action: 'open' | 'create') => void) {
        super(app);
        this.notePath = notePath;
        this.callback = callback;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('monday-duplicate-modal');

        contentEl.createEl('h3', { text: 'Note already exists' });
        contentEl.createEl('p', { text: `A note already exists at:` });
        contentEl.createEl('code', { text: this.notePath, cls: 'monday-modal-path' });
        contentEl.createEl('p', { text: 'What would you like to do?' });

        const buttonContainer = contentEl.createEl('div', { cls: 'monday-modal-buttons' });

        const openBtn = buttonContainer.createEl('button', { text: 'Open existing note', cls: 'mod-cta' });
        openBtn.addEventListener('click', () => {
            this.callback('open');
            this.close();
        });

        const createBtn = buttonContainer.createEl('button', { text: 'Create new note' });
        createBtn.addEventListener('click', () => {
            this.callback('create');
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => {
            this.close();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ============================================================================
// Add Comment Modal
// ============================================================================

class AddCommentModal extends Modal {
    private itemName: string;
    private callback: (comment: string | null) => void;

    constructor(app: App, itemName: string, callback: (comment: string | null) => void) {
        super(app);
        this.itemName = itemName;
        this.callback = callback;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('monday-comment-modal');

        contentEl.createEl('h3', { text: 'Add comment' });
        contentEl.createEl('p', { text: `Adding comment to: ${this.itemName}`, cls: 'monday-comment-item-name' });

        const textArea = contentEl.createEl('textarea', {
            cls: 'monday-comment-textarea',
            attr: { placeholder: 'Enter your comment...' }
        });
        textArea.rows = 5;

        const buttonContainer = contentEl.createEl('div', { cls: 'monday-modal-buttons' });

        const submitBtn = buttonContainer.createEl('button', { text: 'Add comment', cls: 'mod-cta' });
        submitBtn.addEventListener('click', () => {
            const comment = textArea.value.trim();
            if (comment) {
                this.callback(comment);
                this.close();
            } else {
                new Notice('Please enter a comment');
            }
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => {
            this.callback(null);
            this.close();
        });

        // Focus the textarea
        setTimeout(() => textArea.focus(), 50);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ============================================================================
// Create Subtask Modal
// ============================================================================

class CreateSubtaskModal extends Modal {
    private parentItemName: string;
    private callback: (subtaskName: string | null) => void;

    constructor(app: App, parentItemName: string, callback: (subtaskName: string | null) => void) {
        super(app);
        this.parentItemName = parentItemName;
        this.callback = callback;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('monday-subtask-modal');

        contentEl.createEl('h3', { text: 'Add subtask' });
        contentEl.createEl('p', { text: `Adding subtask to: ${this.parentItemName}`, cls: 'monday-subtask-parent-name' });

        const inputEl = contentEl.createEl('input', {
            cls: 'monday-subtask-input',
            attr: {
                type: 'text',
                placeholder: 'Enter subtask name...'
            }
        });

        const buttonContainer = contentEl.createEl('div', { cls: 'monday-modal-buttons' });

        const submitBtn = buttonContainer.createEl('button', { text: 'Create subtask', cls: 'mod-cta' });
        submitBtn.addEventListener('click', () => {
            const subtaskName = inputEl.value.trim();
            if (subtaskName) {
                this.callback(subtaskName);
                this.close();
            } else {
                new Notice('Please enter a subtask name');
            }
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => {
            this.callback(null);
            this.close();
        });

        // Handle Enter key
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const subtaskName = inputEl.value.trim();
                if (subtaskName) {
                    this.callback(subtaskName);
                    this.close();
                }
            }
        });

        // Focus the input
        setTimeout(() => inputEl.focus(), 50);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ============================================================================
// Assign Person Modal
// ============================================================================

interface MondayUser {
    id: string;
    name: string;
    email: string;
}

class AssignPersonModal extends Modal {
    private plugin: MondayIntegrationPlugin;
    private itemName: string;
    private currentAssignees: string[];
    private callback: (userIds: number[] | null) => void;
    private users: MondayUser[] = [];
    private selectedUserIds: Set<number> = new Set();

    constructor(
        app: App,
        plugin: MondayIntegrationPlugin,
        itemName: string,
        currentAssignees: string[],
        callback: (userIds: number[] | null) => void
    ) {
        super(app);
        this.plugin = plugin;
        this.itemName = itemName;
        this.currentAssignees = currentAssignees;
        this.callback = callback;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('monday-assign-modal');

        contentEl.createEl('h3', { text: 'Assign person' });
        contentEl.createEl('p', { text: this.itemName, cls: 'monday-assign-item-name' });

        if (this.currentAssignees.length > 0) {
            contentEl.createEl('p', {
                text: `Currently assigned: ${this.currentAssignees.join(', ')}`,
                cls: 'monday-assign-current'
            });
        }

        // Loading indicator
        const loadingEl = contentEl.createEl('div', { cls: 'monday-loading' });
        loadingEl.createEl('div', { cls: 'monday-spinner' });
        loadingEl.createEl('span', { text: 'Loading users...', cls: 'monday-loading-text' });

        try {
            this.users = await this.plugin.apiClient.getUsers();
            loadingEl.remove();

            // User list
            const userListEl = contentEl.createEl('div', { cls: 'monday-user-list' });

            for (const user of this.users) {
                const userEl = userListEl.createEl('div', { cls: 'monday-user-item' });

                const checkbox = userEl.createEl('input', {
                    attr: { type: 'checkbox', id: `user-${user.id}` }
                });

                // Pre-select if currently assigned
                if (this.currentAssignees.some(a => a.toLowerCase() === user.name.toLowerCase())) {
                    checkbox.checked = true;
                    this.selectedUserIds.add(parseInt(user.id));
                }

                checkbox.addEventListener('change', () => {
                    const userId = parseInt(user.id);
                    if (checkbox.checked) {
                        this.selectedUserIds.add(userId);
                    } else {
                        this.selectedUserIds.delete(userId);
                    }
                });

                const label = userEl.createEl('label', {
                    text: user.name,
                    attr: { for: `user-${user.id}` }
                });
                label.createEl('span', { text: ` (${user.email})`, cls: 'monday-user-email' });
            }

            // Buttons
            const buttonContainer = contentEl.createEl('div', { cls: 'monday-modal-buttons' });

            const clearBtn = buttonContainer.createEl('button', { text: 'Clear all' });
            clearBtn.addEventListener('click', () => {
                this.selectedUserIds.clear();
                userListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
                    (cb as HTMLInputElement).checked = false;
                });
            });

            const submitBtn = buttonContainer.createEl('button', { text: 'Assign', cls: 'mod-cta' });
            submitBtn.addEventListener('click', () => {
                this.callback(Array.from(this.selectedUserIds));
                this.close();
            });

            const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
            cancelBtn.addEventListener('click', () => {
                this.callback(null);
                this.close();
            });

        } catch (error) {
            loadingEl.remove();
            contentEl.createEl('p', {
                text: `Error loading users: ${error instanceof Error ? error.message : 'Unknown error'}`,
                cls: 'monday-sidebar-error'
            });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ============================================================================
// Create Task Modal
// ============================================================================

interface BoardGroup {
    id: string;
    title: string;
    color: string;
}

class CreateTaskModal extends Modal {
    private plugin: MondayIntegrationPlugin;
    private initialText: string;
    private selectedBoardId: string = '';
    private selectedGroupId: string = '';
    private groups: BoardGroup[] = [];
    private taskNameInput: HTMLInputElement | null = null;
    private groupDropdown: HTMLSelectElement | null = null;
    private submitBtn: HTMLButtonElement | null = null;

    constructor(app: App, plugin: MondayIntegrationPlugin, initialText: string = '') {
        super(app);
        this.plugin = plugin;
        this.initialText = initialText;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('monday-create-task-modal');

        contentEl.createEl('h3', { text: 'Create Monday.com task' });

        // Task name input
        const nameContainer = contentEl.createEl('div', { cls: 'monday-modal-field' });
        nameContainer.createEl('label', { text: 'Task name' });
        this.taskNameInput = nameContainer.createEl('input', {
            type: 'text',
            cls: 'monday-task-name-input',
            value: this.initialText
        });
        this.taskNameInput.placeholder = 'Enter task name...';

        // Board dropdown
        const boardContainer = contentEl.createEl('div', { cls: 'monday-modal-field' });
        boardContainer.createEl('label', { text: 'Board' });
        const boardDropdown = boardContainer.createEl('select', { cls: 'monday-board-dropdown' });

        const defaultBoardOption = boardDropdown.createEl('option', { text: 'Select a board...', value: '' });
        defaultBoardOption.disabled = true;
        defaultBoardOption.selected = true;

        for (const board of this.plugin.settings.cachedBoards) {
            const option = boardDropdown.createEl('option', { text: board.name, value: board.id });
            if (board.id === this.plugin.settings.defaultBoardId) {
                option.selected = true;
                this.selectedBoardId = board.id;
            }
        }

        boardDropdown.addEventListener('change', () => {
            this.selectedBoardId = boardDropdown.value;
            void this.loadGroups();
        });

        // Group dropdown
        const groupContainer = contentEl.createEl('div', { cls: 'monday-modal-field' });
        groupContainer.createEl('label', { text: 'Group' });
        this.groupDropdown = groupContainer.createEl('select', { cls: 'monday-group-dropdown' });
        this.groupDropdown.disabled = true;

        const defaultGroupOption = this.groupDropdown.createEl('option', { text: 'Select a board first...', value: '' });
        defaultGroupOption.disabled = true;
        defaultGroupOption.selected = true;

        this.groupDropdown.addEventListener('change', () => {
            this.selectedGroupId = this.groupDropdown!.value;
            this.updateSubmitButton();
        });

        // Load groups if default board is selected
        if (this.selectedBoardId) {
            await this.loadGroups();
        }

        // Buttons
        const buttonContainer = contentEl.createEl('div', { cls: 'monday-modal-buttons' });

        this.submitBtn = buttonContainer.createEl('button', { text: 'Create task', cls: 'mod-cta' });
        this.submitBtn.disabled = true;
        this.submitBtn.addEventListener('click', () => void this.createTask());

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        // Update submit button state when task name changes
        this.taskNameInput.addEventListener('input', () => this.updateSubmitButton());

        // Focus task name input
        setTimeout(() => this.taskNameInput?.focus(), 50);

        // Initial button state
        this.updateSubmitButton();
    }

    private async loadGroups() {
        if (!this.groupDropdown || !this.selectedBoardId) return;

        this.groupDropdown.empty();
        const loadingOption = this.groupDropdown.createEl('option', { text: 'Loading groups...', value: '' });
        loadingOption.disabled = true;
        loadingOption.selected = true;
        this.groupDropdown.disabled = true;
        this.selectedGroupId = '';

        try {
            this.groups = await this.plugin.apiClient.getBoardGroups(this.selectedBoardId);

            this.groupDropdown.empty();

            if (this.groups.length === 0) {
                const noGroupsOption = this.groupDropdown.createEl('option', { text: 'No groups found', value: '' });
                noGroupsOption.disabled = true;
                noGroupsOption.selected = true;
            } else {
                const selectOption = this.groupDropdown.createEl('option', { text: 'Select a group...', value: '' });
                selectOption.disabled = true;
                selectOption.selected = true;

                for (const group of this.groups) {
                    this.groupDropdown.createEl('option', { text: group.title, value: group.id });
                }

                this.groupDropdown.disabled = false;
            }
        } catch (error) {
            this.groupDropdown.empty();
            const errorOption = this.groupDropdown.createEl('option', { text: 'Error loading groups', value: '' });
            errorOption.disabled = true;
            errorOption.selected = true;
            new Notice(`Failed to load groups: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        this.updateSubmitButton();
    }

    private updateSubmitButton() {
        if (!this.submitBtn || !this.taskNameInput) return;

        const hasTaskName = this.taskNameInput.value.trim().length > 0;
        const hasBoard = this.selectedBoardId.length > 0;
        const hasGroup = this.selectedGroupId.length > 0;

        this.submitBtn.disabled = !(hasTaskName && hasBoard && hasGroup);
    }

    private async createTask() {
        if (!this.taskNameInput) return;

        const taskName = this.taskNameInput.value.trim();
        if (!taskName || !this.selectedBoardId || !this.selectedGroupId) {
            new Notice('Please fill in all fields');
            return;
        }

        if (this.submitBtn) {
            this.submitBtn.disabled = true;
            this.submitBtn.textContent = 'Creating...';
        }

        try {
            const result = await this.plugin.apiClient.createItem(
                this.selectedBoardId,
                this.selectedGroupId,
                taskName
            );

            if (result) {
                new Notice(`Task created: ${result.name}`);
                this.close();
            } else {
                new Notice('Failed to create task');
                if (this.submitBtn) {
                    this.submitBtn.disabled = false;
                    this.submitBtn.textContent = 'Create task';
                }
            }
        } catch (error) {
            new Notice(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            if (this.submitBtn) {
                this.submitBtn.disabled = false;
                this.submitBtn.textContent = 'Create task';
            }
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ============================================================================
// Status Bar
// ============================================================================

class StatusBarManager {
    private plugin: MondayIntegrationPlugin;
    private statusBarEl: HTMLElement | null = null;

    constructor(plugin: MondayIntegrationPlugin) {
        this.plugin = plugin;
    }

    enable() {
        if (this.statusBarEl) return;

        this.statusBarEl = this.plugin.addStatusBarItem();
        this.statusBarEl.addClass('monday-status-bar');
        this.statusBarEl.title = 'Click to open Monday.com sidebar';

        this.statusBarEl.addEventListener('click', () => {
            void this.plugin.activateView();
        });

        this.update();
    }

    update() {
        if (!this.statusBarEl) return;

        if (!this.plugin.settings.apiToken) {
            this.statusBarEl.setText('Monday: not configured');
            return;
        }

        const boardCount = this.plugin.settings.cachedBoards.length;
        const lastSync = this.plugin.settings.lastSync;

        let syncText = 'Never synced';
        if (lastSync) {
            const minutes = Math.floor((Date.now() - lastSync) / 60000);
            if (minutes < 1) {
                syncText = 'Just now';
            } else if (minutes < 60) {
                syncText = `${minutes}m ago`;
            } else {
                syncText = `${Math.floor(minutes / 60)}h ago`;
            }
        }

        this.statusBarEl.setText(`Monday: ${boardCount} boards | ${syncText}`);
    }

    disable() {
        if (this.statusBarEl) {
            this.statusBarEl.remove();
            this.statusBarEl = null;
        }
    }
}

// ============================================================================
// Settings Tab
// ============================================================================

class MondaySettingTab extends PluginSettingTab {
    plugin: MondayIntegrationPlugin;

    constructor(app: App, plugin: MondayIntegrationPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // API Configuration
        new Setting(containerEl)
            .setName('API configuration')
            .setHeading();

        new Setting(containerEl)
            .setName('API token')
            .setDesc('Your Monday.com API token. Get it from Monday.com > Profile > Developers > My Access Tokens')
            .addText(text => {
                text.inputEl.type = 'password';
                text.inputEl.addClass('monday-settings-input-wide');
                return text
                    .setPlaceholder('Enter your API token')
                    .setValue(this.plugin.settings.apiToken)
                    .onChange(async (value) => {
                        this.plugin.settings.apiToken = value;
                        await this.plugin.saveSettings();
                        this.plugin.apiClient = new MondayApiClient(value);
                    });
            });

        // Test connection button
        new Setting(containerEl)
            .setName('Test connection')
            .setDesc('Verify your API token works correctly')
            .addButton(button => button
                .setButtonText('Test')
                .onClick(async () => {
                    button.setButtonText('Testing...');
                    button.setDisabled(true);

                    const success = await this.plugin.apiClient.testConnection();

                    if (success) {
                        new Notice('Connection successful!');
                        button.setButtonText('Success!');
                    } else {
                        new Notice('Connection failed. Check your API token.');
                        button.setButtonText('Failed');
                    }

                    setTimeout(() => {
                        button.setButtonText('Test');
                        button.setDisabled(false);
                    }, 2000);
                }));

        // Load boards button
        new Setting(containerEl)
            .setName('Load boards')
            .setDesc('Fetch your Monday.com boards')
            .addButton(button => button
                .setButtonText('Load boards')
                .onClick(async () => {
                    button.setButtonText('Loading...');
                    button.setDisabled(true);

                    try {
                        const boards = await this.plugin.apiClient.getBoards();
                        this.plugin.settings.cachedBoards = boards;
                        this.plugin.settings.lastSync = Date.now();
                        await this.plugin.saveSettings();
                        new Notice(`Loaded ${boards.length} boards`);
                        this.display(); // Refresh settings page
                    } catch (error) {
                        new Notice(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    }

                    button.setButtonText('Load boards');
                    button.setDisabled(false);
                }));

        // Default board selector
        if (this.plugin.settings.cachedBoards.length > 0) {
            new Setting(containerEl)
                .setName('Default board')
                .setDesc('Board to use when none is specified in code blocks')
                .addDropdown(dropdown => {
                    dropdown.addOption('', 'Select a board...');
                    for (const board of this.plugin.settings.cachedBoards) {
                        dropdown.addOption(board.id, board.name);
                    }
                    dropdown.setValue(this.plugin.settings.defaultBoardId);
                    dropdown.onChange(async (value) => {
                        this.plugin.settings.defaultBoardId = value;
                        await this.plugin.saveSettings();
                    });
                });
        }

        // Display options
        new Setting(containerEl)
            .setName('Display')
            .setHeading();

        new Setting(containerEl)
            .setName('Show status bar')
            .setDesc('Display Monday.com sync status in the status bar')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showStatusBar)
                .onChange(async (value) => {
                    this.plugin.settings.showStatusBar = value;
                    await this.plugin.saveSettings();
                    if (value) {
                        this.plugin.statusBar.enable();
                    } else {
                        this.plugin.statusBar.disable();
                    }
                }));

        new Setting(containerEl)
            .setName('Show status dropdown')
            .setDesc('Display quick status change dropdown on sidebar items')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showStatusDropdown)
                .onChange(async (value) => {
                    this.plugin.settings.showStatusDropdown = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Auto-refresh interval')
            .setDesc('How often to refresh data in minutes (0 to disable)')
            .addText(text => text
                .setPlaceholder('5')
                .setValue(this.plugin.settings.refreshInterval.toString())
                .onChange(async (value) => {
                    const num = parseInt(value) || 0;
                    this.plugin.settings.refreshInterval = num;
                    await this.plugin.saveSettings();
                }));

        // Note creation settings
        new Setting(containerEl)
            .setName('Note creation')
            .setHeading();

        new Setting(containerEl)
            .setName('Note folder')
            .setDesc('Folder where notes created from Monday.com items will be saved')
            .addText(text => text
                .setPlaceholder('Monday')
                .setValue(this.plugin.settings.noteFolder)
                .onChange(async (value) => {
                    this.plugin.settings.noteFolder = value || 'Monday';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Note name template')
            .setDesc('Template for note names. Use {name}, {board}, {group}, {id} as placeholders')
            .addText(text => {
                text.inputEl.addClass('monday-settings-input-medium');
                return text
                    .setPlaceholder('{name}')
                    .setValue(this.plugin.settings.noteNameTemplate)
                    .onChange(async (value) => {
                        this.plugin.settings.noteNameTemplate = value || '{name}';
                        await this.plugin.saveSettings();
                    });
            });

        const templateExamples = containerEl.createEl('div', { cls: 'monday-template-examples' });
        templateExamples.createEl('p', { text: 'Examples:', cls: 'monday-template-title' });
        const exampleList = templateExamples.createEl('ul');
        exampleList.createEl('li', { text: '{name} → "Fix login bug"' });
        exampleList.createEl('li', { text: '{board}/{name} → "Project Alpha/Fix login bug"' });
        exampleList.createEl('li', { text: '{group} - {name} → "Sprint 1 - Fix login bug"' });

        // Usage section
        new Setting(containerEl)
            .setName('Usage')
            .setHeading();

        const usageEl = containerEl.createEl('div', { cls: 'monday-usage' });
        usageEl.createEl('p', { text: 'Add a Monday.com dashboard to any note by inserting a code block:' });

        const codeExample = usageEl.createEl('pre');
        codeExample.createEl('code', {
            text: '```monday\nboard: YOUR_BOARD_ID\ntitle: My Tasks\nlimit: 25\n```'
        });

        usageEl.createEl('p', { text: 'Options:' });
        const optionsList = usageEl.createEl('ul');
        optionsList.createEl('li', { text: 'board: board ID (required if no default set)' });
        optionsList.createEl('li', { text: 'title: custom title (optional)' });
        optionsList.createEl('li', { text: 'limit: max items to show (default: 25)' });
        optionsList.createEl('li', { text: 'columns: comma-separated column IDs to display' });

        // Support section
        new Setting(containerEl)
            .setName('Support this plugin')
            .setHeading();

        const supportEl = containerEl.createEl('div', { cls: 'monday-support' });
        supportEl.createEl('p', {
            text: 'If this plugin helps you stay organised, consider buying me a coffee!'
        });

        const coffeeLink = supportEl.createEl('a', {
            href: 'https://buymeacoffee.com/maframpton',
            cls: 'monday-coffee-link'
        });
        coffeeLink.setAttr('target', '_blank');

        const coffeeImg = coffeeLink.createEl('img', {
            cls: 'monday-coffee-button'
        });
        coffeeImg.setAttr('src', 'https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png');
        coffeeImg.setAttr('alt', 'Buy Me A Coffee');
        coffeeImg.setAttr('height', '50');
    }
}

// ============================================================================
// Main Plugin
// ============================================================================

export default class MondayIntegrationPlugin extends Plugin {
    settings: MondayIntegrationSettings;
    apiClient: MondayApiClient;
    statusBar: StatusBarManager;
    currentBoardId: string = ''; // Shared board selection between views

    async onload() {
        console.debug('Loading Monday.com Integration plugin');

        await this.loadSettings();

        // Initialise API client
        this.apiClient = new MondayApiClient(this.settings.apiToken);

        // Initialise status bar
        this.statusBar = new StatusBarManager(this);
        if (this.settings.showStatusBar) {
            this.statusBar.enable();
        }

        // Register sidebar view
        this.registerView(
            MONDAY_VIEW_TYPE,
            (leaf) => new MondayView(leaf, this)
        );

        // Register team summary view
        this.registerView(
            MONDAY_TEAM_VIEW_TYPE,
            (leaf) => new MondayTeamView(leaf, this)
        );

        // Register code block processor
        this.registerMarkdownCodeBlockProcessor(
            'monday',
            (source, el, ctx) => {
                const options = parseDashboardOptions(source);
                const renderer = new MondayDashboardRenderer(el, this, options);
                ctx.addChild(renderer);
            }
        );

        // Add ribbon icon
        this.addRibbonIcon('calendar-check', 'Open Monday.com', () => {
            void this.activateView();
        });

        // Add ribbon icon for team view
        this.addRibbonIcon('users', 'Open Monday team summary', () => {
            void this.activateTeamView();
        });

        // Add commands
        this.addCommand({
            id: 'insert-monday-board',
            name: 'Insert board dashboard',
            editorCallback: (editor) => {
                const boardId = this.settings.defaultBoardId || 'YOUR_BOARD_ID';
                const block = `\`\`\`monday\nboard: ${boardId}\ntitle: My Tasks\n\`\`\`\n`;
                editor.replaceSelection(block);
            }
        });

        this.addCommand({
            id: 'open-monday-sidebar',
            name: 'Open sidebar',
            callback: () => {
                void this.activateView();
            }
        });

        this.addCommand({
            id: 'open-monday-team-summary',
            name: 'Open team summary',
            callback: () => {
                void this.activateTeamView();
            }
        });

        this.addCommand({
            id: 'refresh-monday-data',
            name: 'Refresh boards',
            callback: async () => {
                if (!this.settings.apiToken) {
                    new Notice('Please configure your API token first');
                    return;
                }
                try {
                    new Notice('Refreshing Monday.com boards...');
                    const boards = await this.apiClient.getBoards();
                    this.settings.cachedBoards = boards;
                    this.settings.lastSync = Date.now();
                    await this.saveSettings();
                    void this.statusBar.update();
                    new Notice(`Loaded ${boards.length} boards`);
                } catch (error) {
                    new Notice(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
        });

        // Command to create a Monday.com task from selection or prompt
        this.addCommand({
            id: 'create-monday-task',
            name: 'Create Monday.com task',
            editorCallback: (editor: Editor) => {
                if (!this.settings.apiToken) {
                    new Notice('Please configure your Monday.com API token first');
                    return;
                }
                if (this.settings.cachedBoards.length === 0) {
                    new Notice('Please load your Monday.com boards first (Settings > Monday.com Integration)');
                    return;
                }
                const selection = editor.getSelection();
                new CreateTaskModal(this.app, this, selection).open();
            }
        });

        // Register editor context menu (right-click)
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
                if (!this.settings.apiToken || this.settings.cachedBoards.length === 0) {
                    return; // Don't show menu item if not configured
                }

                const selection = editor.getSelection();

                menu.addItem((item) => {
                    item.setTitle(selection ? 'Create Monday.com task from selection' : 'Create Monday.com task')
                        .setIcon('calendar-check')
                        .onClick(() => {
                            new CreateTaskModal(this.app, this, selection).open();
                        });
                });
            })
        );

        // Add settings tab
        this.addSettingTab(new MondaySettingTab(this.app, this));
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf = workspace.getLeavesOfType(MONDAY_VIEW_TYPE)[0];

        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                await rightLeaf.setViewState({
                    type: MONDAY_VIEW_TYPE,
                    active: true
                });
                leaf = rightLeaf;
            }
        }

        if (leaf) {
            void workspace.revealLeaf(leaf);
        }
    }

    async activateTeamView() {
        const { workspace } = this.app;

        let leaf = workspace.getLeavesOfType(MONDAY_TEAM_VIEW_TYPE)[0];

        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                await rightLeaf.setViewState({
                    type: MONDAY_TEAM_VIEW_TYPE,
                    active: true
                });
                leaf = rightLeaf;
            }
        }

        if (leaf) {
            void workspace.revealLeaf(leaf);
        }
    }

    // Sync board selection across all Monday views
    syncBoardSelection(boardId: string, sourceView: 'main' | 'team') {
        this.currentBoardId = boardId;
        const { workspace } = this.app;

        // Sync to main view if source was team view
        if (sourceView === 'team') {
            const mondayLeaves = workspace.getLeavesOfType(MONDAY_VIEW_TYPE);
            for (const leaf of mondayLeaves) {
                const view = leaf.view as MondayView;
                view.setBoard(boardId);
            }
        }

        // Sync to team view if source was main view
        if (sourceView === 'main') {
            const teamLeaves = workspace.getLeavesOfType(MONDAY_TEAM_VIEW_TYPE);
            for (const leaf of teamLeaves) {
                const view = leaf.view as MondayTeamView;
                view.setBoard(boardId);
            }
        }
    }

    onunload() {
        console.debug('Unloading Monday.com Integration plugin');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
