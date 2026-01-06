/*
Monday.com Integration Plugin for Obsidian
*/

var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => MondayIntegrationPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var MONDAY_VIEW_TYPE = "monday-view";
var MONDAY_TEAM_VIEW_TYPE = "monday-team-view";
var MONDAY_API_URL = "https://api.monday.com/v2";
var DEFAULT_SETTINGS = {
  apiToken: "",
  defaultBoardId: "",
  refreshInterval: 5,
  showStatusBar: true,
  showStatusDropdown: true,
  cachedBoards: [],
  lastSync: 0,
  noteFolder: "Monday",
  noteNameTemplate: "{name}"
};
var MondayApiClient = class {
  constructor(apiToken) {
    this.apiToken = apiToken;
  }
  async query(graphql) {
    var _a;
    if (!this.apiToken) {
      throw new Error("API token not configured");
    }
    const response = await (0, import_obsidian.requestUrl)({
      url: MONDAY_API_URL,
      method: "POST",
      headers: {
        "Authorization": this.apiToken,
        "Content-Type": "application/json",
        "API-Version": "2024-01"
      },
      body: JSON.stringify({ query: graphql })
    });
    const json = response.json;
    if (json.errors) {
      throw new Error(((_a = json.errors[0]) == null ? void 0 : _a.message) || "API error");
    }
    return json.data;
  }
  async testConnection() {
    try {
      const data = await this.query("{ me { name } }");
      return !!data.me;
    } catch (e) {
      return false;
    }
  }
  async getBoards() {
    const data = await this.query(`
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
  async getBoardData(boardId, limit = 50) {
    var _a;
    const data = await this.query(`
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
      items: ((_a = board.items_page) == null ? void 0 : _a.items) || []
    };
  }
  async changeItemStatus(boardId, itemId, columnId, statusLabel) {
    try {
      const value = JSON.stringify({ label: statusLabel });
      await this.query(`
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
      console.error("Failed to change status:", error);
      throw error;
    }
  }
  async changeSubitemStatus(subitemId, columnId, statusLabel) {
    var _a, _b, _c;
    try {
      const boardData = await this.query(`
                query {
                    items(ids: [${subitemId}]) {
                        board { id }
                    }
                }
            `);
      const subitemBoardId = (_c = (_b = (_a = boardData.items) == null ? void 0 : _a[0]) == null ? void 0 : _b.board) == null ? void 0 : _c.id;
      if (!subitemBoardId) {
        throw new Error("Could not find subitem board");
      }
      const value = JSON.stringify({ label: statusLabel });
      await this.query(`
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
      console.error("Failed to change subitem status:", error);
      throw error;
    }
  }
  async addItemUpdate(itemId, body) {
    try {
      await this.query(`
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
      console.error("Failed to add update:", error);
      throw error;
    }
  }
  async getStatusColumnSettings(boardId, columnId) {
    var _a, _b, _c, _d;
    try {
      const data = await this.query(`
                query {
                    boards(ids: [${boardId}]) {
                        columns(ids: ["${columnId}"]) {
                            settings_str
                        }
                    }
                }
            `);
      if ((_d = (_c = (_b = (_a = data.boards) == null ? void 0 : _a[0]) == null ? void 0 : _b.columns) == null ? void 0 : _c[0]) == null ? void 0 : _d.settings_str) {
        const settings = JSON.parse(data.boards[0].columns[0].settings_str);
        if (settings.labels) {
          return Object.values(settings.labels);
        }
      }
      return [];
    } catch (error) {
      console.error("Failed to get status settings:", error);
      return [];
    }
  }
  async getBoardGroups(boardId) {
    var _a, _b;
    try {
      const data = await this.query(`
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
      return ((_b = (_a = data.boards) == null ? void 0 : _a[0]) == null ? void 0 : _b.groups) || [];
    } catch (error) {
      console.error("Failed to get board groups:", error);
      return [];
    }
  }
  async createItem(boardId, groupId, itemName) {
    try {
      const data = await this.query(`
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
      console.error("Failed to create item:", error);
      throw error;
    }
  }
  async createSubitem(parentItemId, subitemName) {
    try {
      const data = await this.query(`
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
      console.error("Failed to create subitem:", error);
      throw error;
    }
  }
  async getUsers() {
    try {
      const data = await this.query(`
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
      console.error("Failed to get users:", error);
      throw error;
    }
  }
  async assignPerson(boardId, itemId, columnId, personIds) {
    try {
      const personsValue = JSON.stringify({
        personsAndTeams: personIds.map((id) => ({ id, kind: "person" }))
      });
      await this.query(`
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
      console.error("Failed to assign person:", error);
      throw error;
    }
  }
  async assignPersonToSubitem(parentItemId, subitemId, columnId, personIds) {
    var _a, _b, _c;
    try {
      const boardData = await this.query(`
                query {
                    items(ids: [${subitemId}]) {
                        board { id }
                    }
                }
            `);
      const subitemBoardId = (_c = (_b = (_a = boardData.items) == null ? void 0 : _a[0]) == null ? void 0 : _b.board) == null ? void 0 : _c.id;
      if (!subitemBoardId) {
        throw new Error("Could not find subitem board");
      }
      return await this.assignPerson(subitemBoardId, subitemId, columnId, personIds);
    } catch (error) {
      console.error("Failed to assign person to subitem:", error);
      throw error;
    }
  }
};
var MondayDashboardRenderer = class extends import_obsidian.MarkdownRenderChild {
  constructor(containerEl, plugin, options) {
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
    container.addClass("monday-dashboard");
    if (!this.plugin.settings.apiToken) {
      this.renderError(container, "API token not configured. Go to Settings > Monday.com Integration.");
      return;
    }
    const boardId = this.options.board || this.plugin.settings.defaultBoardId;
    if (!boardId) {
      this.renderError(container, 'No board specified. Add "board: YOUR_BOARD_ID" to the code block.');
      return;
    }
    this.renderLoading(container);
    try {
      const boardData = await this.plugin.apiClient.getBoardData(boardId, this.options.limit * 2);
      if (!boardData) {
        container.empty();
        this.renderError(container, "Board not found or you don't have access.");
        return;
      }
      const filteredItems = this.filterItems(boardData.items, boardData.columns);
      const filteredBoardData = {
        ...boardData,
        items: filteredItems.slice(0, this.options.limit)
      };
      container.empty();
      this.renderBoard(container, filteredBoardData);
    } catch (error) {
      container.empty();
      this.renderError(container, `Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
  filterItems(items, columns) {
    const { statusInclude, statusExclude, groupInclude, groupExclude } = this.options.filter;
    if (statusInclude.length === 0 && statusExclude.length === 0 && groupInclude.length === 0 && groupExclude.length === 0) {
      return items;
    }
    const statusColumns = columns.filter((c) => c.type === "status");
    return items.filter((item) => {
      var _a, _b;
      const itemGroup = ((_b = (_a = item.group) == null ? void 0 : _a.title) == null ? void 0 : _b.toLowerCase()) || "";
      for (const excludeGroup of groupExclude) {
        if (itemGroup.includes(excludeGroup) || excludeGroup.includes(itemGroup)) {
          return false;
        }
      }
      if (groupInclude.length > 0) {
        const groupMatch = groupInclude.some(
          (includeGroup) => itemGroup.includes(includeGroup) || includeGroup.includes(itemGroup)
        );
        if (!groupMatch) {
          return false;
        }
      }
      const itemStatuses = [];
      for (const statusCol of statusColumns) {
        const colValue = item.column_values.find((cv) => cv.id === statusCol.id);
        if (colValue == null ? void 0 : colValue.text) {
          itemStatuses.push(colValue.text.toLowerCase());
        }
      }
      for (const excludeStatus of statusExclude) {
        if (itemStatuses.some((s) => s.includes(excludeStatus) || excludeStatus.includes(s))) {
          return false;
        }
      }
      if (statusInclude.length > 0) {
        return statusInclude.some(
          (includeStatus) => itemStatuses.some((s) => s.includes(includeStatus) || includeStatus.includes(s))
        );
      }
      return true;
    });
  }
  renderLoading(container) {
    const loadingEl = container.createEl("div", { cls: "monday-loading" });
    loadingEl.createEl("div", { cls: "monday-spinner" });
    loadingEl.createEl("div", { text: "Loading Monday.com data...", cls: "monday-loading-text" });
  }
  renderError(container, message) {
    const errorEl = container.createEl("div", { cls: "monday-error" });
    errorEl.createEl("span", { text: message });
  }
  renderBoard(container, boardData) {
    const title = this.options.title || boardData.name;
    container.createEl("div", { text: title, cls: "monday-board-title" });
    const headerEl = container.createEl("div", { cls: "monday-header-actions" });
    headerEl.createEl("span", { text: this.options.style, cls: "monday-style-badge" });
    const refreshBtn = headerEl.createEl("button", { text: "Refresh", cls: "monday-refresh-btn" });
    refreshBtn.addEventListener("click", () => void this.render());
    if (boardData.items.length === 0) {
      container.createEl("div", { text: "No items found", cls: "monday-empty" });
      return;
    }
    switch (this.options.style) {
      case "table":
        this.renderTable(container, boardData);
        break;
      case "compact":
        this.renderCompact(container, boardData);
        break;
      case "cards":
      default:
        this.renderCards(container, boardData);
        break;
    }
    container.createEl("div", {
      text: `Showing ${boardData.items.length} items`,
      cls: "monday-item-count"
    });
  }
  getColumnsToShow(boardData) {
    return this.options.columns.length > 0 ? boardData.columns.filter((c) => this.options.columns.includes(c.id) || this.options.columns.includes(c.title.toLowerCase())) : boardData.columns.filter((c) => c.type === "status" || c.type === "date" || c.type === "person");
  }
  renderStatusBadge(container, colValue, column) {
    var _a;
    if (column.type === "status") {
      const statusBadge = container.createEl("span", {
        text: colValue.text,
        cls: "monday-status-badge"
      });
      try {
        const valueObj = colValue.value ? JSON.parse(colValue.value) : null;
        if ((_a = valueObj == null ? void 0 : valueObj.label_style) == null ? void 0 : _a.color) {
          statusBadge.style.backgroundColor = valueObj.label_style.color;
        }
      } catch (e) {
      }
    } else {
      container.createEl("span", { text: colValue.text });
    }
  }
  renderCards(container, boardData) {
    const itemsContainer = container.createEl("div", { cls: "monday-items monday-items-cards" });
    const columnsToShow = this.getColumnsToShow(boardData);
    for (const item of boardData.items) {
      const card = itemsContainer.createEl("div", { cls: "monday-item-card" });
      card.createEl("div", { text: item.name, cls: "monday-item-name" });
      if (item.group) {
        const groupBadge = card.createEl("span", {
          text: item.group.title,
          cls: "monday-group-badge"
        });
        groupBadge.style.backgroundColor = item.group.color || "#579bfc";
      }
      const columnsEl = card.createEl("div", { cls: "monday-item-columns" });
      for (const column of columnsToShow) {
        const colValue = item.column_values.find((cv) => cv.id === column.id);
        if (colValue && colValue.text) {
          const colEl = columnsEl.createEl("div", { cls: "monday-column-value" });
          colEl.createEl("span", { text: column.title + ": ", cls: "monday-column-label" });
          this.renderStatusBadge(colEl, colValue, column);
        }
      }
    }
  }
  renderTable(container, boardData) {
    const tableContainer = container.createEl("div", { cls: "monday-table-container" });
    const table = tableContainer.createEl("table", { cls: "monday-table" });
    const columnsToShow = this.getColumnsToShow(boardData);
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: "Item" });
    headerRow.createEl("th", { text: "Group" });
    for (const column of columnsToShow) {
      headerRow.createEl("th", { text: column.title });
    }
    const tbody = table.createEl("tbody");
    for (const item of boardData.items) {
      const row = tbody.createEl("tr");
      row.createEl("td", { text: item.name, cls: "monday-table-item-name" });
      const groupCell = row.createEl("td");
      if (item.group) {
        const groupBadge = groupCell.createEl("span", {
          text: item.group.title,
          cls: "monday-group-badge monday-group-badge-small"
        });
        groupBadge.style.backgroundColor = item.group.color || "#579bfc";
      }
      for (const column of columnsToShow) {
        const cell = row.createEl("td");
        const colValue = item.column_values.find((cv) => cv.id === column.id);
        if (colValue && colValue.text) {
          this.renderStatusBadge(cell, colValue, column);
        }
      }
    }
  }
  renderCompact(container, boardData) {
    const listContainer = container.createEl("div", { cls: "monday-items monday-items-compact" });
    const columnsToShow = this.getColumnsToShow(boardData);
    for (const item of boardData.items) {
      const itemEl = listContainer.createEl("div", { cls: "monday-compact-item" });
      const statusCol = columnsToShow.find((c) => c.type === "status");
      if (statusCol) {
        const colValue = item.column_values.find((cv) => cv.id === statusCol.id);
        if (colValue && colValue.text) {
          this.renderStatusBadge(itemEl, colValue, statusCol);
        }
      }
      itemEl.createEl("span", { text: item.name, cls: "monday-compact-name" });
      if (item.group) {
        const groupBadge = itemEl.createEl("span", {
          text: item.group.title,
          cls: "monday-group-badge monday-group-badge-small"
        });
        groupBadge.style.backgroundColor = item.group.color || "#579bfc";
      }
    }
  }
};
function parseDashboardOptions(source) {
  const options = {
    board: "",
    title: "",
    limit: 25,
    columns: [],
    style: "cards",
    filter: {
      statusInclude: [],
      statusExclude: [],
      groupInclude: [],
      groupExclude: []
    }
  };
  const lines = source.trim().split("\n");
  for (const line of lines) {
    const [key, ...valueParts] = line.split(":");
    const value = valueParts.join(":").trim();
    switch (key.trim().toLowerCase()) {
      case "board":
        options.board = value;
        break;
      case "title":
        options.title = value;
        break;
      case "limit":
        options.limit = parseInt(value) || 25;
        break;
      case "columns":
        options.columns = value.split(",").map((c) => c.trim().toLowerCase()).filter((c) => c);
        break;
      case "style":
        const styleValue = value.toLowerCase();
        if (styleValue === "table" || styleValue === "compact" || styleValue === "cards") {
          options.style = styleValue;
        }
        break;
      case "status":
      case "filter":
        const statuses = value.split(",").map((s) => s.trim()).filter((s) => s);
        for (const status of statuses) {
          if (status.startsWith("!")) {
            options.filter.statusExclude.push(status.slice(1).toLowerCase());
          } else {
            options.filter.statusInclude.push(status.toLowerCase());
          }
        }
        break;
      case "group":
        const groups = value.split(",").map((g) => g.trim()).filter((g) => g);
        for (const group of groups) {
          if (group.startsWith("!")) {
            options.filter.groupExclude.push(group.slice(1).toLowerCase());
          } else {
            options.filter.groupInclude.push(group.toLowerCase());
          }
        }
        break;
    }
  }
  return options;
}
var MondayView = class extends import_obsidian.ItemView {
  // Track expanded items for subitems
  constructor(leaf, plugin) {
    super(leaf);
    this.selectedBoardId = null;
    this.currentBoardData = null;
    this.statusFilter = { selected: /* @__PURE__ */ new Set(), mode: "include" };
    this.groupFilter = { selected: /* @__PURE__ */ new Set(), mode: "include" };
    this.personFilter = null;
    // Filter by team member name
    this.availableStatuses = /* @__PURE__ */ new Map();
    // columnId -> status labels
    this.expandedItems = /* @__PURE__ */ new Set();
    this.plugin = plugin;
  }
  getViewType() {
    return MONDAY_VIEW_TYPE;
  }
  getDisplayText() {
    return "Monday.com";
  }
  getIcon() {
    return "calendar-check";
  }
  async onOpen() {
    if (!this.selectedBoardId) {
      this.selectedBoardId = this.plugin.currentBoardId || this.plugin.settings.defaultBoardId || null;
    }
    await this.render();
  }
  async render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("monday-sidebar");
    if (!this.plugin.settings.apiToken) {
      const errorEl = container.createEl("div", { cls: "monday-sidebar-error" });
      errorEl.createEl("p", { text: "API token not configured." });
      const settingsBtn = errorEl.createEl("button", { text: "Open settings" });
      settingsBtn.addEventListener("click", () => {
        this.app.setting.open();
        this.app.setting.openTabById("monday-integration");
      });
      return;
    }
    const headerEl = container.createEl("div", { cls: "monday-sidebar-header" });
    headerEl.createEl("h4", { text: "Monday.com" });
    const refreshBtn = headerEl.createEl("button", { cls: "monday-sidebar-refresh" });
    refreshBtn.setText("\u21BB");
    refreshBtn.title = "Refresh boards";
    refreshBtn.addEventListener("click", () => void this.refreshBoards());
    const selectorEl = container.createEl("div", { cls: "monday-board-selector" });
    const selectEl = selectorEl.createEl("select", { cls: "monday-board-select" });
    const defaultOption = selectEl.createEl("option", { text: "Select a board...", value: "" });
    defaultOption.disabled = true;
    defaultOption.selected = !this.selectedBoardId;
    for (const board of this.plugin.settings.cachedBoards) {
      const option = selectEl.createEl("option", {
        text: board.name,
        value: board.id
      });
      if (board.id === this.selectedBoardId) {
        option.selected = true;
      }
    }
    selectEl.addEventListener("change", (e) => {
      const boardId = e.target.value;
      this.selectedBoardId = boardId;
      this.statusFilter = { selected: /* @__PURE__ */ new Set(), mode: "include" };
      this.groupFilter = { selected: /* @__PURE__ */ new Set(), mode: "include" };
      this.personFilter = null;
      this.currentBoardData = null;
      void this.loadAndRenderBoard(container);
      this.plugin.syncBoardSelection(boardId, "main");
    });
    container.createEl("div", { cls: "monday-sidebar-filters" });
    const itemsContainer = container.createEl("div", { cls: "monday-sidebar-items" });
    if (this.selectedBoardId) {
      await this.loadAndRenderBoard(container);
    } else if (this.plugin.settings.cachedBoards.length === 0) {
      itemsContainer.createEl("p", { text: "Click refresh to load boards.", cls: "monday-sidebar-hint" });
    }
  }
  async loadAndRenderBoard(container) {
    const htmlContainer = container;
    const filtersContainer = htmlContainer.querySelector(".monday-sidebar-filters");
    const itemsContainer = htmlContainer.querySelector(".monday-sidebar-items");
    if (!this.selectedBoardId)
      return;
    if (itemsContainer) {
      itemsContainer.empty();
      itemsContainer.createEl("div", { text: "Loading items...", cls: "monday-sidebar-loading" });
    }
    try {
      const isFirstLoad = !this.currentBoardData;
      if (!this.currentBoardData) {
        this.currentBoardData = await this.plugin.apiClient.getBoardData(this.selectedBoardId, 100);
        if (this.currentBoardData) {
          const statusColumns = this.currentBoardData.columns.filter((c) => c.type === "status");
          for (const col of statusColumns) {
            const statuses = await this.plugin.apiClient.getStatusColumnSettings(this.selectedBoardId, col.id);
            if (statuses.length > 0) {
              this.availableStatuses.set(col.id, statuses);
            }
          }
        }
      }
      if (isFirstLoad && this.currentBoardData) {
        const statusColumns = this.currentBoardData.columns.filter((c) => c.type === "status");
        for (const col of statusColumns) {
          const statuses = this.availableStatuses.get(col.id) || [];
          const doneStatus = statuses.find((s) => s.toLowerCase() === "done");
          if (doneStatus) {
            this.statusFilter.selected.add(doneStatus);
            this.statusFilter.mode = "exclude";
            break;
          }
        }
      }
      if (!this.currentBoardData) {
        if (itemsContainer) {
          itemsContainer.empty();
          itemsContainer.createEl("p", { text: "Board not found." });
        }
        return;
      }
      this.renderFilters(filtersContainer, this.currentBoardData);
      this.renderFilteredItems(itemsContainer, this.currentBoardData);
    } catch (error) {
      if (itemsContainer) {
        itemsContainer.empty();
        itemsContainer.createEl("p", {
          text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          cls: "monday-sidebar-error"
        });
      }
    }
  }
  renderFilters(container, boardData) {
    var _a;
    if (!container)
      return;
    container.empty();
    const statuses = /* @__PURE__ */ new Set();
    const statusColumns = boardData.columns.filter((c) => c.type === "status");
    for (const item of boardData.items) {
      for (const statusCol of statusColumns) {
        const colValue = item.column_values.find((cv) => cv.id === statusCol.id);
        if (colValue == null ? void 0 : colValue.text) {
          statuses.add(colValue.text);
        }
      }
    }
    const groups = /* @__PURE__ */ new Set();
    for (const item of boardData.items) {
      if ((_a = item.group) == null ? void 0 : _a.title) {
        groups.add(item.group.title);
      }
    }
    const refreshItems = () => {
      var _a2;
      const itemsContainer = (_a2 = container.parentElement) == null ? void 0 : _a2.querySelector(".monday-sidebar-items");
      if (itemsContainer && this.currentBoardData) {
        this.renderFilteredItems(itemsContainer, this.currentBoardData);
      }
    };
    if (statuses.size > 0) {
      const statusSection = container.createEl("div", { cls: "monday-filter-section collapsed" });
      const statusHeader = statusSection.createEl("div", { cls: "monday-filter-header" });
      const statusTitleArea = statusHeader.createEl("div", { cls: "monday-filter-title-area" });
      statusTitleArea.createEl("span", { cls: "monday-filter-chevron", text: "\u25B6" });
      statusTitleArea.createEl("span", { text: "Status", cls: "monday-filter-title" });
      const statusCount = statusTitleArea.createEl("span", { cls: "monday-filter-count" });
      const updateStatusCount = () => {
        const count = this.statusFilter.selected.size;
        statusCount.textContent = count > 0 ? `(${count} ${this.statusFilter.mode === "exclude" ? "hidden" : "selected"})` : "";
      };
      updateStatusCount();
      statusTitleArea.addEventListener("click", () => {
        statusSection.classList.toggle("collapsed");
      });
      const statusControls = statusHeader.createEl("div", { cls: "monday-filter-controls" });
      const statusModeBtn = statusControls.createEl("button", {
        cls: `monday-filter-mode ${this.statusFilter.mode}`,
        text: this.statusFilter.mode === "include" ? "Show" : "Hide"
      });
      statusModeBtn.title = this.statusFilter.mode === "include" ? "Show only selected (click to switch to Hide mode)" : "Hide selected (click to switch to Show mode)";
      statusModeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.statusFilter.mode = this.statusFilter.mode === "include" ? "exclude" : "include";
        statusModeBtn.textContent = this.statusFilter.mode === "include" ? "Show" : "Hide";
        statusModeBtn.className = `monday-filter-mode ${this.statusFilter.mode}`;
        statusModeBtn.title = this.statusFilter.mode === "include" ? "Show only selected (click to switch to Hide mode)" : "Hide selected (click to switch to Show mode)";
        updateStatusCount();
        refreshItems();
      });
      const statusClearBtn = statusControls.createEl("button", {
        cls: "monday-filter-clear",
        text: "\u2715"
      });
      statusClearBtn.title = "Clear all";
      statusClearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.statusFilter.selected.clear();
        statusSection.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
          cb.checked = false;
        });
        updateStatusCount();
        refreshItems();
      });
      const statusList = statusSection.createEl("div", { cls: "monday-filter-list" });
      for (const status of Array.from(statuses).sort()) {
        const label = statusList.createEl("label", { cls: "monday-filter-checkbox" });
        const checkbox = label.createEl("input", { type: "checkbox" });
        checkbox.checked = this.statusFilter.selected.has(status);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            this.statusFilter.selected.add(status);
          } else {
            this.statusFilter.selected.delete(status);
          }
          updateStatusCount();
          refreshItems();
        });
        label.createEl("span", { text: status });
      }
    }
    if (groups.size > 0) {
      const groupSection = container.createEl("div", { cls: "monday-filter-section collapsed" });
      const groupHeader = groupSection.createEl("div", { cls: "monday-filter-header" });
      const groupTitleArea = groupHeader.createEl("div", { cls: "monday-filter-title-area" });
      groupTitleArea.createEl("span", { cls: "monday-filter-chevron", text: "\u25B6" });
      groupTitleArea.createEl("span", { text: "Group", cls: "monday-filter-title" });
      const groupCount = groupTitleArea.createEl("span", { cls: "monday-filter-count" });
      const updateGroupCount = () => {
        const count = this.groupFilter.selected.size;
        groupCount.textContent = count > 0 ? `(${count} ${this.groupFilter.mode === "exclude" ? "hidden" : "selected"})` : "";
      };
      updateGroupCount();
      groupTitleArea.addEventListener("click", () => {
        groupSection.classList.toggle("collapsed");
      });
      const groupControls = groupHeader.createEl("div", { cls: "monday-filter-controls" });
      const groupModeBtn = groupControls.createEl("button", {
        cls: `monday-filter-mode ${this.groupFilter.mode}`,
        text: this.groupFilter.mode === "include" ? "Show" : "Hide"
      });
      groupModeBtn.title = this.groupFilter.mode === "include" ? "Show only selected (click to switch to Hide mode)" : "Hide selected (click to switch to Show mode)";
      groupModeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.groupFilter.mode = this.groupFilter.mode === "include" ? "exclude" : "include";
        groupModeBtn.textContent = this.groupFilter.mode === "include" ? "Show" : "Hide";
        groupModeBtn.className = `monday-filter-mode ${this.groupFilter.mode}`;
        groupModeBtn.title = this.groupFilter.mode === "include" ? "Show only selected (click to switch to Hide mode)" : "Hide selected (click to switch to Show mode)";
        updateGroupCount();
        refreshItems();
      });
      const groupClearBtn = groupControls.createEl("button", {
        cls: "monday-filter-clear",
        text: "\u2715"
      });
      groupClearBtn.title = "Clear all";
      groupClearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.groupFilter.selected.clear();
        groupSection.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
          cb.checked = false;
        });
        updateGroupCount();
        refreshItems();
      });
      const groupList = groupSection.createEl("div", { cls: "monday-filter-list" });
      for (const group of Array.from(groups).sort()) {
        const label = groupList.createEl("label", { cls: "monday-filter-checkbox" });
        const checkbox = label.createEl("input", { type: "checkbox" });
        checkbox.checked = this.groupFilter.selected.has(group);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            this.groupFilter.selected.add(group);
          } else {
            this.groupFilter.selected.delete(group);
          }
          updateGroupCount();
          refreshItems();
        });
        label.createEl("span", { text: group });
      }
    }
  }
  renderFilteredItems(container, boardData) {
    var _a, _b, _c;
    container.empty();
    let filteredItems = boardData.items;
    if (this.statusFilter.selected.size > 0) {
      const statusColumns = boardData.columns.filter((c) => c.type === "status");
      filteredItems = filteredItems.filter((item) => {
        let itemStatus = "";
        for (const statusCol of statusColumns) {
          const colValue = item.column_values.find((cv) => cv.id === statusCol.id);
          if (colValue == null ? void 0 : colValue.text) {
            itemStatus = colValue.text;
            break;
          }
        }
        const isSelected = this.statusFilter.selected.has(itemStatus);
        return this.statusFilter.mode === "include" ? isSelected : !isSelected;
      });
    }
    if (this.groupFilter.selected.size > 0) {
      filteredItems = filteredItems.filter((item) => {
        var _a2;
        const itemGroup = ((_a2 = item.group) == null ? void 0 : _a2.title) || "";
        const isSelected = this.groupFilter.selected.has(itemGroup);
        return this.groupFilter.mode === "include" ? isSelected : !isSelected;
      });
    }
    if (this.personFilter) {
      const peopleColumns = boardData.columns.filter((c) => c.type === "people" || c.type === "multiple-person");
      filteredItems = filteredItems.filter((item) => {
        const assignees = this.getItemAssignees(item, peopleColumns);
        return assignees.includes(this.personFilter);
      });
    }
    if (filteredItems.length === 0) {
      container.createEl("p", { text: "No items match the filters.", cls: "monday-sidebar-hint" });
      return;
    }
    const groupedItems = /* @__PURE__ */ new Map();
    for (const item of filteredItems) {
      const groupName = ((_a = item.group) == null ? void 0 : _a.title) || "No Group";
      if (!groupedItems.has(groupName)) {
        groupedItems.set(groupName, []);
      }
      groupedItems.get(groupName).push(item);
    }
    for (const [groupName, items] of groupedItems) {
      const groupEl = container.createEl("div", { cls: "monday-sidebar-group" });
      const groupTitleEl = groupEl.createEl("div", { text: groupName, cls: "monday-sidebar-group-title" });
      const groupColors = ["#00c875", "#fdab3d", "#a25ddc", "#579bfc", "#e2445c"];
      const colorIndex = Array.from(groupedItems.keys()).indexOf(groupName) % groupColors.length;
      const hexColor = groupColors[colorIndex];
      groupTitleEl.style.borderLeftColor = hexColor;
      groupTitleEl.style.color = hexColor;
      for (const item of items) {
        const itemWrapper = groupEl.createEl("div", { cls: "monday-sidebar-item-wrapper" });
        const itemEl = itemWrapper.createEl("div", { cls: "monday-sidebar-item monday-sidebar-item-clickable" });
        const hasSubitems = item.subitems && item.subitems.length > 0;
        const isExpanded = this.expandedItems.has(item.id);
        if (hasSubitems) {
          const expandBtn = itemEl.createEl("span", {
            cls: `monday-expand-btn ${isExpanded ? "expanded" : ""}`,
            text: isExpanded ? "\u25BC" : "\u25B6"
          });
          expandBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (this.expandedItems.has(item.id)) {
              this.expandedItems.delete(item.id);
            } else {
              this.expandedItems.add(item.id);
            }
            const itemsContainer = this.containerEl.querySelector(".monday-sidebar-items");
            if (itemsContainer && this.currentBoardData) {
              this.renderFilteredItems(itemsContainer, this.currentBoardData);
            }
          });
        } else {
          itemEl.createEl("span", {
            cls: "monday-no-subtasks-icon",
            text: "\u25CB"
          });
        }
        const nameEl = itemEl.createEl("span", { text: item.name, cls: "monday-sidebar-item-name" });
        nameEl.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.handleItemClick(item, boardData);
        });
        const actionsEl = itemEl.createEl("div", { cls: "monday-item-actions" });
        const statusColumn = boardData.columns.find((c) => c.type === "status");
        const statusColValue = statusColumn ? item.column_values.find((cv) => cv.id === statusColumn.id) : null;
        const currentStatus = (statusColValue == null ? void 0 : statusColValue.text) || "";
        if (this.plugin.settings.showStatusDropdown && statusColumn && this.availableStatuses.has(statusColumn.id)) {
          const statusOptions = this.availableStatuses.get(statusColumn.id) || [];
          const statusDropdown = actionsEl.createEl("select", { cls: "monday-status-dropdown" });
          statusDropdown.title = "Change status";
          for (const status of statusOptions) {
            const opt = statusDropdown.createEl("option", { text: status, value: status });
            if (status === currentStatus) {
              opt.selected = true;
            }
          }
          statusDropdown.addEventListener("change", async (e) => {
            e.stopPropagation();
            const newStatus = e.target.value;
            if (newStatus !== currentStatus && this.selectedBoardId) {
              await this.changeItemStatus(item, statusColumn.id, newStatus);
            }
          });
          statusDropdown.addEventListener("click", (e) => e.stopPropagation());
        }
        if (currentStatus) {
          const statusBadge = actionsEl.createEl("span", {
            text: currentStatus,
            cls: "monday-sidebar-status"
          });
          try {
            const valueObj = (statusColValue == null ? void 0 : statusColValue.value) ? JSON.parse(statusColValue.value) : null;
            if ((_b = valueObj == null ? void 0 : valueObj.label_style) == null ? void 0 : _b.color) {
              statusBadge.style.backgroundColor = valueObj.label_style.color;
            }
          } catch (e) {
          }
        }
        itemEl.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.showItemContextMenu(e, item, boardData);
        });
        if (hasSubitems && isExpanded && item.subitems) {
          const subitemsContainer = itemWrapper.createEl("div", { cls: "monday-subitems-container" });
          let filteredSubitemsCount = 0;
          for (const subitem of item.subitems) {
            if (this.statusFilter.selected.size > 0) {
              let subitemStatus = "";
              for (const cv of subitem.column_values) {
                if (cv.value) {
                  try {
                    const valueObj = JSON.parse(cv.value);
                    if (typeof (valueObj == null ? void 0 : valueObj.index) === "number") {
                      subitemStatus = cv.text || "";
                      break;
                    }
                  } catch (e) {
                  }
                }
              }
              const isSelected = this.statusFilter.selected.has(subitemStatus);
              const shouldShow = this.statusFilter.mode === "include" ? isSelected : !isSelected;
              if (!shouldShow)
                continue;
            }
            filteredSubitemsCount++;
            const subitemEl = subitemsContainer.createEl("div", { cls: "monday-subitem monday-subitem-clickable" });
            subitemEl.createEl("span", { text: "\u2514\u2500", cls: "monday-subitem-prefix" });
            const subitemNameEl = subitemEl.createEl("span", { text: subitem.name, cls: "monday-subitem-name" });
            subitemNameEl.addEventListener("click", (e) => {
              e.stopPropagation();
              void this.handleSubitemClick(subitem, item, boardData);
            });
            subitemEl.addEventListener("contextmenu", (e) => {
              e.preventDefault();
              e.stopPropagation();
              this.showSubitemContextMenu(e, subitem, item, boardData);
            });
            for (const cv of subitem.column_values) {
              if (cv.value && cv.text) {
                try {
                  const valueObj = JSON.parse(cv.value);
                  if (typeof (valueObj == null ? void 0 : valueObj.index) === "number") {
                    const statusBadge = subitemEl.createEl("span", {
                      text: cv.text,
                      cls: "monday-subitem-status"
                    });
                    if ((_c = valueObj.label_style) == null ? void 0 : _c.color) {
                      statusBadge.style.backgroundColor = valueObj.label_style.color;
                    }
                    break;
                  }
                } catch (e) {
                }
              }
            }
          }
          if (filteredSubitemsCount === 0) {
            const hintEl = subitemsContainer.createEl("div", { cls: "monday-subitem monday-subitems-filtered-hint" });
            hintEl.createEl("span", { text: "\u2514\u2500", cls: "monday-subitem-prefix" });
            hintEl.createEl("span", { text: `(${item.subitems.length} subtasks hidden by filter)`, cls: "monday-subitem-hint-text" });
          }
          const addSubtaskBtn = subitemsContainer.createEl("div", { cls: "monday-add-subtask" });
          addSubtaskBtn.createEl("span", { text: "\u2514\u2500", cls: "monday-subitem-prefix" });
          addSubtaskBtn.createEl("span", { text: "+ Add subtask", cls: "monday-add-subtask-text" });
          addSubtaskBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            new CreateSubtaskModal(this.app, item.name, async (subtaskName) => {
              if (subtaskName) {
                await this.createSubtask(item, subtaskName);
              }
            }).open();
          });
        }
      }
    }
    container.createEl("div", {
      text: `Showing ${filteredItems.length} of ${boardData.items.length} items`,
      cls: "monday-sidebar-item-count"
    });
  }
  async handleItemClick(item, boardData) {
    const plugin = this.plugin;
    const app = this.app;
    const noteName = this.generateNoteName(item, boardData);
    const noteFolder = plugin.settings.noteFolder || "Monday";
    const notePath = (0, import_obsidian.normalizePath)(`${noteFolder}/${noteName}.md`);
    const existingFile = app.vault.getAbstractFileByPath(notePath);
    if (existingFile && existingFile instanceof import_obsidian.TFile) {
      new DuplicateNoteModal(app, notePath, async (action) => {
        if (action === "open") {
          await app.workspace.openLinkText(notePath, "", false);
        } else if (action === "create") {
          let counter = 1;
          let newPath = notePath;
          while (app.vault.getAbstractFileByPath(newPath)) {
            newPath = (0, import_obsidian.normalizePath)(`${noteFolder}/${noteName} (${counter}).md`);
            counter++;
          }
          await this.createNoteForItem(item, boardData, newPath);
        }
      }).open();
    } else {
      await this.createNoteForItem(item, boardData, notePath);
    }
  }
  generateNoteName(item, boardData) {
    var _a;
    const template = this.plugin.settings.noteNameTemplate || "{name}";
    const boardName = boardData.name || "Unknown Board";
    const groupName = ((_a = item.group) == null ? void 0 : _a.title) || "No Group";
    const sanitise = (str) => str.replace(/[\\/:*?"<>|]/g, "-");
    return template.replace("{name}", sanitise(item.name)).replace("{board}", sanitise(boardName)).replace("{group}", sanitise(groupName)).replace("{id}", item.id);
  }
  async createNoteForItem(item, boardData, notePath) {
    var _a, _b;
    const app = this.app;
    const plugin = this.plugin;
    const folderPath = notePath.substring(0, notePath.lastIndexOf("/"));
    if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
      await app.vault.createFolder(folderPath);
    }
    const statusCol = item.column_values.find((cv) => {
      const col = boardData.columns.find((c) => c.id === cv.id);
      return (col == null ? void 0 : col.type) === "status";
    });
    const dateCol = item.column_values.find((cv) => {
      const col = boardData.columns.find((c) => c.id === cv.id);
      return (col == null ? void 0 : col.type) === "date";
    });
    const personCol = item.column_values.find((cv) => {
      const col = boardData.columns.find((c) => c.id === cv.id);
      return (col == null ? void 0 : col.type) === "person" || (col == null ? void 0 : col.type) === "people";
    });
    const board = plugin.settings.cachedBoards.find((b) => b.id === this.selectedBoardId);
    const frontmatter = {
      title: item.name,
      monday_id: item.id,
      monday_board: boardData.name,
      monday_board_id: this.selectedBoardId || "",
      status: (statusCol == null ? void 0 : statusCol.text) || "",
      group: ((_a = item.group) == null ? void 0 : _a.title) || "",
      created: new Date().toISOString().split("T")[0],
      tags: ["monday"]
    };
    if (dateCol == null ? void 0 : dateCol.text) {
      frontmatter["due_date"] = dateCol.text;
    }
    if (personCol == null ? void 0 : personCol.text) {
      frontmatter["assigned"] = personCol.text;
    }
    let content = "---\n";
    for (const [key, value] of Object.entries(frontmatter)) {
      if (Array.isArray(value)) {
        content += `${key}:
`;
        for (const v of value) {
          content += `  - ${v}
`;
        }
      } else if (value) {
        content += `${key}: "${value}"
`;
      }
    }
    content += "---\n\n";
    content += `# ${item.name}

`;
    content += `## Details

`;
    content += `- **Board:** ${boardData.name}
`;
    content += `- **Group:** ${((_b = item.group) == null ? void 0 : _b.title) || "None"}
`;
    content += `- **Status:** ${(statusCol == null ? void 0 : statusCol.text) || "None"}
`;
    if (dateCol == null ? void 0 : dateCol.text) {
      content += `- **Due Date:** ${dateCol.text}
`;
    }
    if (personCol == null ? void 0 : personCol.text) {
      content += `- **Assigned:** ${personCol.text}
`;
    }
    if (item.subitems && item.subitems.length > 0) {
      content += `
## Subtasks

`;
      for (const subitem of item.subitems) {
        const subitemStatus = subitem.column_values.find((cv) => {
          const col = boardData.columns.find((c) => c.id === cv.id);
          return (col == null ? void 0 : col.type) === "status";
        });
        const statusText = (subitemStatus == null ? void 0 : subitemStatus.text) ? ` - ${subitemStatus.text}` : "";
        const subitemNoteName = this.generateSubitemNoteName(subitem, item, boardData);
        content += `- [ ] [[${subitemNoteName}]]${statusText}
`;
      }
    }
    content += `
## Notes

`;
    const file = await app.vault.create(notePath, content);
    await app.workspace.openLinkText(notePath, "", false);
    new import_obsidian.Notice(`Created note: ${file.basename}`);
  }
  async handleSubitemClick(subitem, parentItem, boardData) {
    const plugin = this.plugin;
    const app = this.app;
    const noteName = this.generateSubitemNoteName(subitem, parentItem, boardData);
    const noteFolder = plugin.settings.noteFolder || "Monday";
    const notePath = (0, import_obsidian.normalizePath)(`${noteFolder}/${noteName}.md`);
    const existingFile = app.vault.getAbstractFileByPath(notePath);
    if (existingFile && existingFile instanceof import_obsidian.TFile) {
      await app.workspace.openLinkText(notePath, "", false);
    } else {
      await this.createNoteForSubitem(subitem, parentItem, boardData, notePath);
    }
  }
  generateSubitemNoteName(subitem, parentItem, boardData) {
    var _a;
    const template = this.plugin.settings.noteNameTemplate || "{name}";
    const boardName = boardData.name || "Unknown Board";
    const groupName = ((_a = parentItem.group) == null ? void 0 : _a.title) || "No Group";
    const sanitise = (str) => str.replace(/[\\/:*?"<>|]/g, "-");
    return template.replace("{name}", sanitise(subitem.name)).replace("{board}", sanitise(boardName)).replace("{group}", sanitise(groupName)).replace("{id}", subitem.id);
  }
  async createNoteForSubitem(subitem, parentItem, boardData, notePath) {
    const app = this.app;
    const plugin = this.plugin;
    const folderPath = notePath.substring(0, notePath.lastIndexOf("/"));
    if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
      await app.vault.createFolder(folderPath);
    }
    const statusCol = subitem.column_values.find((cv) => {
      const col = boardData.columns.find((c) => c.id === cv.id);
      return (col == null ? void 0 : col.type) === "status";
    });
    const frontmatter = {
      title: subitem.name,
      monday_id: subitem.id,
      monday_parent_id: parentItem.id,
      monday_parent: parentItem.name,
      monday_board: boardData.name,
      monday_board_id: this.selectedBoardId || "",
      status: (statusCol == null ? void 0 : statusCol.text) || "",
      type: "subtask",
      created: new Date().toISOString().split("T")[0],
      tags: ["monday", "subtask"]
    };
    let content = "---\n";
    for (const [key, value] of Object.entries(frontmatter)) {
      if (Array.isArray(value)) {
        content += `${key}:
`;
        for (const v of value) {
          content += `  - ${v}
`;
        }
      } else if (value) {
        content += `${key}: "${value}"
`;
      }
    }
    content += "---\n\n";
    content += `# ${subitem.name}

`;
    const parentNoteName = this.generateNoteName(parentItem, boardData);
    content += `## Parent Task

`;
    content += `[[${parentNoteName}]]

`;
    content += `## Details

`;
    content += `- **Board:** ${boardData.name}
`;
    content += `- **Parent:** ${parentItem.name}
`;
    content += `- **Status:** ${(statusCol == null ? void 0 : statusCol.text) || "None"}
`;
    if (parentItem.subitems && parentItem.subitems.length > 1) {
      content += `
## Related Subtasks

`;
      for (const sibling of parentItem.subitems) {
        if (sibling.id !== subitem.id) {
          const siblingStatus = sibling.column_values.find((cv) => {
            const col = boardData.columns.find((c) => c.id === cv.id);
            return (col == null ? void 0 : col.type) === "status";
          });
          const statusText = (siblingStatus == null ? void 0 : siblingStatus.text) ? ` - ${siblingStatus.text}` : "";
          const siblingNoteName = this.generateSubitemNoteName(sibling, parentItem, boardData);
          content += `- [[${siblingNoteName}]]${statusText}
`;
        }
      }
    }
    content += `
## Notes

`;
    const file = await app.vault.create(notePath, content);
    await app.workspace.openLinkText(notePath, "", false);
    new import_obsidian.Notice(`Created note: ${file.basename}`);
  }
  showItemContextMenu(event, item, boardData) {
    const menu = new import_obsidian.Menu();
    menu.addItem((menuItem) => {
      menuItem.setTitle("Create note").setIcon("file-plus").onClick(() => {
        void this.handleItemClick(item, boardData);
      });
    });
    menu.addSeparator();
    const statusColumn = boardData.columns.find((c) => c.type === "status");
    if (statusColumn && this.availableStatuses.has(statusColumn.id)) {
      const statusOptions = this.availableStatuses.get(statusColumn.id) || [];
      const currentStatusValue = item.column_values.find((cv) => cv.id === statusColumn.id);
      const currentStatus = (currentStatusValue == null ? void 0 : currentStatusValue.text) || "";
      menu.addItem((menuItem) => {
        menuItem.setTitle("Change status").setIcon("check-circle");
        const submenu = menuItem.setSubmenu();
        for (const status of statusOptions) {
          submenu.addItem((subItem) => {
            subItem.setTitle(status).setChecked(status === currentStatus).onClick(() => {
              if (status !== currentStatus) {
                void this.changeItemStatus(item, statusColumn.id, status);
              }
            });
          });
        }
      });
    }
    menu.addItem((menuItem) => {
      menuItem.setTitle("Add comment").setIcon("message-square").onClick(() => {
        new AddCommentModal(this.app, item.name, async (comment) => {
          if (comment) {
            await this.addItemComment(item, comment);
          }
        }).open();
      });
    });
    const peopleColumn = boardData.columns.find((c) => c.type === "people" || c.type === "multiple-person");
    if (peopleColumn) {
      const currentAssignees = this.getItemAssignees(item, [peopleColumn]);
      menu.addItem((menuItem) => {
        menuItem.setTitle(currentAssignees.length > 0 ? "Reassign" : "Assign person").setIcon("user-plus").onClick(() => {
          new AssignPersonModal(
            this.app,
            this.plugin,
            item.name,
            currentAssignees,
            async (userIds) => {
              if (userIds !== null && this.selectedBoardId) {
                await this.assignPersonToItem(item, boardData, peopleColumn.id, userIds);
              }
            }
          ).open();
        });
      });
    }
    menu.addItem((menuItem) => {
      menuItem.setTitle("Add subtask").setIcon("list-plus").onClick(() => {
        new CreateSubtaskModal(this.app, item.name, async (subtaskName) => {
          if (subtaskName) {
            await this.createSubtask(item, subtaskName);
          }
        }).open();
      });
    });
    menu.showAtMouseEvent(event);
  }
  showSubitemContextMenu(event, subitem, parentItem, boardData) {
    const menu = new import_obsidian.Menu();
    menu.addItem((menuItem) => {
      menuItem.setTitle("Create note").setIcon("file-plus").onClick(() => {
        void this.handleSubitemClick(subitem, parentItem, boardData);
      });
    });
    menu.addSeparator();
    let statusColumnId = "";
    let currentStatus = "";
    for (const cv of subitem.column_values) {
      if (cv.value) {
        try {
          const parsed = JSON.parse(cv.value);
          if (typeof parsed.index === "number") {
            statusColumnId = cv.id;
            currentStatus = cv.text || "";
            break;
          }
        } catch (e) {
        }
      }
    }
    if (statusColumnId) {
      const statusColumn = boardData.columns.find((c) => c.type === "status");
      const statusOptions = statusColumn ? this.availableStatuses.get(statusColumn.id) || [] : [];
      if (statusOptions.length > 0) {
        menu.addItem((menuItem) => {
          menuItem.setTitle("Change status").setIcon("check-circle");
          const submenu = menuItem.setSubmenu();
          for (const status of statusOptions) {
            submenu.addItem((subItem) => {
              subItem.setTitle(status).setChecked(status === currentStatus).onClick(() => {
                if (status !== currentStatus) {
                  void this.changeSubitemStatus(subitem, parentItem, statusColumnId, status);
                }
              });
            });
          }
        });
      }
    }
    const currentAssignees = [];
    for (const cv of subitem.column_values) {
      if (cv.value && cv.text) {
        try {
          const parsed = JSON.parse(cv.value);
          if (parsed.personsAndTeams !== void 0 && cv.text) {
            const names = cv.text.split(",").map((n) => n.trim()).filter((n) => n);
            currentAssignees.push(...names);
          }
        } catch (e) {
        }
      }
    }
    menu.addItem((menuItem) => {
      menuItem.setTitle(currentAssignees.length > 0 ? "Reassign" : "Assign person").setIcon("user-plus").onClick(() => {
        new AssignPersonModal(
          this.app,
          this.plugin,
          subitem.name,
          currentAssignees,
          async (userIds) => {
            if (userIds !== null) {
              await this.assignPersonToSubitem(subitem, parentItem, boardData, userIds);
            }
          }
        ).open();
      });
    });
    menu.showAtMouseEvent(event);
  }
  async changeItemStatus(item, columnId, newStatus) {
    if (!this.selectedBoardId)
      return;
    try {
      new import_obsidian.Notice(`Changing status to "${newStatus}"...`);
      await this.plugin.apiClient.changeItemStatus(
        this.selectedBoardId,
        item.id,
        columnId,
        newStatus
      );
      new import_obsidian.Notice(`Status updated to "${newStatus}"`);
      this.currentBoardData = null;
      const container = this.containerEl.children[1];
      await this.loadAndRenderBoard(container);
    } catch (error) {
      new import_obsidian.Notice(`Failed to change status: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
  async changeSubitemStatus(subitem, parentItem, columnId, newStatus) {
    try {
      new import_obsidian.Notice(`Changing status to "${newStatus}"...`);
      await this.plugin.apiClient.changeSubitemStatus(subitem.id, columnId, newStatus);
      new import_obsidian.Notice(`Status updated to "${newStatus}"`);
      this.currentBoardData = null;
      await this.loadAndRenderBoard(this.containerEl.children[1]);
    } catch (error) {
      new import_obsidian.Notice(`Failed to change status: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
  async addItemComment(item, comment) {
    try {
      new import_obsidian.Notice("Adding comment...");
      await this.plugin.apiClient.addItemUpdate(item.id, comment);
      new import_obsidian.Notice("Comment added successfully");
    } catch (error) {
      new import_obsidian.Notice(`Failed to add comment: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
  async createSubtask(item, subtaskName) {
    try {
      new import_obsidian.Notice("Creating subtask...");
      const result = await this.plugin.apiClient.createSubitem(item.id, subtaskName);
      if (result) {
        new import_obsidian.Notice(`Subtask created: ${result.name}`);
        this.expandedItems.add(item.id);
        await this.loadAndRenderBoard(this.containerEl.children[1]);
      } else {
        new import_obsidian.Notice("Failed to create subtask");
      }
    } catch (error) {
      new import_obsidian.Notice(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
  async assignPersonToItem(item, boardData, columnId, userIds) {
    if (!this.selectedBoardId)
      return;
    try {
      new import_obsidian.Notice("Updating assignment...");
      await this.plugin.apiClient.assignPerson(this.selectedBoardId, item.id, columnId, userIds);
      new import_obsidian.Notice(userIds.length > 0 ? "Person assigned" : "Assignment cleared");
      this.currentBoardData = null;
      await this.loadAndRenderBoard(this.containerEl.children[1]);
    } catch (error) {
      new import_obsidian.Notice(`Failed to assign: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
  async assignPersonToSubitem(subitem, parentItem, boardData, userIds) {
    try {
      let peopleColumnId = "";
      for (const cv of subitem.column_values) {
        if (cv.value) {
          try {
            const parsed = JSON.parse(cv.value);
            if (parsed.personsAndTeams !== void 0) {
              peopleColumnId = cv.id;
              break;
            }
          } catch (e) {
          }
        }
      }
      if (!peopleColumnId) {
        const peopleCol = boardData.columns.find((c) => c.type === "people" || c.type === "multiple-person");
        if (peopleCol)
          peopleColumnId = peopleCol.id;
      }
      if (!peopleColumnId) {
        new import_obsidian.Notice("Could not find people column");
        return;
      }
      new import_obsidian.Notice("Updating assignment...");
      await this.plugin.apiClient.assignPersonToSubitem(parentItem.id, subitem.id, peopleColumnId, userIds);
      new import_obsidian.Notice(userIds.length > 0 ? "Person assigned" : "Assignment cleared");
      this.currentBoardData = null;
      await this.loadAndRenderBoard(this.containerEl.children[1]);
    } catch (error) {
      new import_obsidian.Notice(`Failed to assign: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
  async refreshBoards() {
    try {
      new import_obsidian.Notice("Refreshing Monday.com boards...");
      const boards = await this.plugin.apiClient.getBoards();
      this.plugin.settings.cachedBoards = boards;
      this.plugin.settings.lastSync = Date.now();
      await this.plugin.saveSettings();
      new import_obsidian.Notice(`Loaded ${boards.length} boards`);
      await this.render();
    } catch (error) {
      new import_obsidian.Notice(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
  getItemAssignees(item, peopleColumns) {
    const assignees = [];
    for (const col of peopleColumns) {
      const colValue = item.column_values.find((cv) => cv.id === col.id);
      if (colValue == null ? void 0 : colValue.value) {
        try {
          const parsed = JSON.parse(colValue.value);
          if (parsed.personsAndTeams && Array.isArray(parsed.personsAndTeams)) {
            if (colValue.text) {
              const names = colValue.text.split(",").map((n) => n.trim()).filter((n) => n);
              assignees.push(...names);
            }
          }
        } catch (e) {
          if (colValue.text) {
            const names = colValue.text.split(",").map((n) => n.trim()).filter((n) => n);
            assignees.push(...names);
          }
        }
      }
    }
    return [...new Set(assignees)];
  }
  // Public method to set board from other views (for sync)
  setBoard(boardId) {
    if (this.selectedBoardId === boardId)
      return;
    this.selectedBoardId = boardId;
    this.statusFilter = { selected: /* @__PURE__ */ new Set(), mode: "include" };
    this.groupFilter = { selected: /* @__PURE__ */ new Set(), mode: "include" };
    this.personFilter = null;
    this.currentBoardData = null;
    void this.render();
  }
  // Public method to set person filter from Team View
  setPersonFilter(personName) {
    this.personFilter = personName;
    if (this.currentBoardData) {
      const container = this.containerEl.children[1];
      const itemsContainer = container.querySelector(".monday-sidebar-items");
      if (itemsContainer) {
        this.renderFilteredItems(itemsContainer, this.currentBoardData);
      }
      this.updatePersonFilterIndicator(container);
    }
  }
  updatePersonFilterIndicator(container) {
    const existing = container.querySelector(".monday-person-filter-indicator");
    if (existing)
      existing.remove();
    if (this.personFilter) {
      const filtersContainer = container.querySelector(".monday-sidebar-filters");
      if (filtersContainer) {
        const indicator = filtersContainer.createEl("div", { cls: "monday-person-filter-indicator" });
        indicator.createEl("span", { text: `Filtered: ${this.personFilter}`, cls: "monday-person-filter-text" });
        const clearBtn = indicator.createEl("span", { text: "\u2715", cls: "monday-person-filter-clear" });
        clearBtn.addEventListener("click", () => {
          this.setPersonFilter(null);
        });
      }
    }
  }
  async onClose() {
  }
};
var MondayTeamView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.selectedBoardId = "";
    this.plugin = plugin;
  }
  getViewType() {
    return MONDAY_TEAM_VIEW_TYPE;
  }
  getDisplayText() {
    return "Monday Team";
  }
  getIcon() {
    return "users";
  }
  async onOpen() {
    if (!this.selectedBoardId) {
      this.selectedBoardId = this.plugin.currentBoardId || this.plugin.settings.defaultBoardId || "";
    }
    await this.render();
  }
  async render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("monday-team-sidebar");
    if (!this.plugin.settings.apiToken) {
      const errorEl = container.createEl("div", { cls: "monday-sidebar-error" });
      errorEl.createEl("p", { text: "API token not configured." });
      const settingsBtn = errorEl.createEl("button", { text: "Open settings" });
      settingsBtn.addEventListener("click", () => {
        this.app.setting.open();
        this.app.setting.openTabById("monday-integration");
      });
      return;
    }
    const headerEl = container.createEl("div", { cls: "monday-sidebar-header" });
    headerEl.createEl("h4", { text: "Team Summary" });
    const refreshBtn = headerEl.createEl("button", { cls: "monday-sidebar-refresh" });
    refreshBtn.setText("\u21BB");
    refreshBtn.title = "Refresh";
    refreshBtn.addEventListener("click", () => void this.render());
    const selectorEl = container.createEl("div", { cls: "monday-board-selector" });
    const selectEl = selectorEl.createEl("select", { cls: "monday-board-select" });
    const defaultOption = selectEl.createEl("option", { text: "Select a board...", value: "" });
    defaultOption.disabled = true;
    defaultOption.selected = !this.selectedBoardId;
    for (const board of this.plugin.settings.cachedBoards) {
      const option = selectEl.createEl("option", {
        text: board.name,
        value: board.id
      });
      if (board.id === this.selectedBoardId) {
        option.selected = true;
      }
    }
    selectEl.addEventListener("change", (e) => {
      const boardId = e.target.value;
      this.selectedBoardId = boardId;
      void this.loadAndRenderTeamStats(container);
      this.plugin.syncBoardSelection(boardId, "team");
    });
    container.createEl("div", { cls: "monday-team-stats" });
    if (this.selectedBoardId) {
      await this.loadAndRenderTeamStats(container);
    } else if (this.plugin.settings.cachedBoards.length === 0) {
      const statsContainer = container.querySelector(".monday-team-stats");
      statsContainer.createEl("p", { text: "Click refresh in main view to load boards.", cls: "monday-sidebar-hint" });
    }
  }
  async loadAndRenderTeamStats(container) {
    const statsContainer = container.querySelector(".monday-team-stats");
    if (!statsContainer)
      return;
    statsContainer.empty();
    const loadingEl = statsContainer.createEl("div", { cls: "monday-loading" });
    loadingEl.createEl("div", { cls: "monday-spinner" });
    loadingEl.createEl("span", { text: "Loading team data...", cls: "monday-loading-text" });
    try {
      const boardData = await this.plugin.apiClient.getBoardData(this.selectedBoardId, 500);
      statsContainer.empty();
      if (!boardData || boardData.items.length === 0) {
        statsContainer.createEl("p", { text: "No items found.", cls: "monday-sidebar-hint" });
        return;
      }
      const teamStats = this.aggregateTeamStats(boardData);
      if (teamStats.length === 0) {
        statsContainer.createEl("p", { text: "No assigned tasks found.", cls: "monday-sidebar-hint" });
        return;
      }
      this.renderTeamStats(statsContainer, teamStats);
    } catch (error) {
      statsContainer.empty();
      statsContainer.createEl("p", {
        text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        cls: "monday-sidebar-error"
      });
    }
  }
  aggregateTeamStats(boardData) {
    const statsMap = /* @__PURE__ */ new Map();
    const peopleColumns = boardData.columns.filter((c) => c.type === "people" || c.type === "multiple-person");
    const statusColumns = boardData.columns.filter((c) => c.type === "status");
    const dateColumns = boardData.columns.filter((c) => c.type === "date" || c.type === "timeline");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (const item of boardData.items) {
      const assignees = this.getAssignees(item, peopleColumns);
      if (assignees.length === 0)
        continue;
      const status = this.getItemStatus(item, statusColumns);
      const isDone = status.toLowerCase().includes("done");
      const isWorkingOnIt = status.toLowerCase().includes("working") || status.toLowerCase().includes("in progress") || status.toLowerCase().includes("active");
      const isOverdue = !isDone && this.isItemOverdue(item, dateColumns, today);
      for (const assignee of assignees) {
        if (!statsMap.has(assignee)) {
          statsMap.set(assignee, {
            name: assignee,
            workingOnIt: 0,
            done: 0,
            overdue: 0
          });
        }
        const stats = statsMap.get(assignee);
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
    return Array.from(statsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }
  getAssignees(item, peopleColumns) {
    const assignees = [];
    for (const col of peopleColumns) {
      const colValue = item.column_values.find((cv) => cv.id === col.id);
      if (colValue == null ? void 0 : colValue.value) {
        try {
          const parsed = JSON.parse(colValue.value);
          if (parsed.personsAndTeams && Array.isArray(parsed.personsAndTeams)) {
            if (colValue.text) {
              const names = colValue.text.split(",").map((n) => n.trim()).filter((n) => n);
              assignees.push(...names);
            }
          }
        } catch (e) {
          if (colValue.text) {
            const names = colValue.text.split(",").map((n) => n.trim()).filter((n) => n);
            assignees.push(...names);
          }
        }
      }
    }
    return [...new Set(assignees)];
  }
  getItemStatus(item, statusColumns) {
    for (const col of statusColumns) {
      const colValue = item.column_values.find((cv) => cv.id === col.id);
      if (colValue == null ? void 0 : colValue.text) {
        return colValue.text;
      }
    }
    return "";
  }
  isItemOverdue(item, dateColumns, today) {
    for (const col of dateColumns) {
      const colValue = item.column_values.find((cv) => cv.id === col.id);
      if (colValue == null ? void 0 : colValue.value) {
        try {
          const parsed = JSON.parse(colValue.value);
          const dateStr = parsed.date || parsed.to;
          if (dateStr) {
            const dueDate = new Date(dateStr);
            dueDate.setHours(0, 0, 0, 0);
            if (dueDate < today) {
              return true;
            }
          }
        } catch (e) {
        }
      }
    }
    return false;
  }
  renderTeamStats(container, stats) {
    for (const member of stats) {
      const memberEl = container.createEl("div", { cls: "monday-team-member monday-team-member-clickable" });
      memberEl.title = `Click to filter by ${member.name}`;
      memberEl.addEventListener("click", () => {
        this.filterMainViewByPerson(member.name);
      });
      memberEl.createEl("span", { text: member.name, cls: "monday-team-member-name" });
      const badgesEl = memberEl.createEl("div", { cls: "monday-team-badges" });
      if (member.workingOnIt > 0) {
        const workingBadge = badgesEl.createEl("span", {
          text: String(member.workingOnIt),
          cls: "monday-team-badge monday-team-badge-working"
        });
        workingBadge.title = "Working on it";
      }
      if (member.done > 0) {
        const doneBadge = badgesEl.createEl("span", {
          text: String(member.done),
          cls: "monday-team-badge monday-team-badge-done"
        });
        doneBadge.title = "Done";
      }
      if (member.overdue > 0) {
        const overdueBadge = badgesEl.createEl("span", {
          text: String(member.overdue),
          cls: "monday-team-badge monday-team-badge-overdue"
        });
        overdueBadge.title = "Overdue";
      }
      if (member.workingOnIt === 0 && member.done === 0 && member.overdue === 0) {
        badgesEl.createEl("span", { text: "-", cls: "monday-team-no-tasks" });
      }
    }
    const totalWorking = stats.reduce((sum, s) => sum + s.workingOnIt, 0);
    const totalDone = stats.reduce((sum, s) => sum + s.done, 0);
    const totalOverdue = stats.reduce((sum, s) => sum + s.overdue, 0);
    const summaryEl = container.createEl("div", { cls: "monday-team-summary" });
    summaryEl.createEl("span", { text: "Total:", cls: "monday-team-summary-label" });
    const summaryBadges = summaryEl.createEl("div", { cls: "monday-team-badges" });
    const workingSummary = summaryBadges.createEl("span", {
      text: String(totalWorking),
      cls: "monday-team-badge monday-team-badge-working"
    });
    workingSummary.title = "Total working";
    const doneSummary = summaryBadges.createEl("span", {
      text: String(totalDone),
      cls: "monday-team-badge monday-team-badge-done"
    });
    doneSummary.title = "Total done";
    const overdueSummary = summaryBadges.createEl("span", {
      text: String(totalOverdue),
      cls: "monday-team-badge monday-team-badge-overdue"
    });
    overdueSummary.title = "Total overdue";
  }
  // Public method to set board from other views (for sync)
  setBoard(boardId) {
    if (this.selectedBoardId === boardId)
      return;
    this.selectedBoardId = boardId;
    void this.render();
  }
  filterMainViewByPerson(personName) {
    const { workspace } = this.app;
    const mondayLeaves = workspace.getLeavesOfType(MONDAY_VIEW_TYPE);
    if (mondayLeaves.length > 0) {
      const mondayView = mondayLeaves[0].view;
      mondayView.setPersonFilter(personName);
      workspace.revealLeaf(mondayLeaves[0]);
      new import_obsidian.Notice(`Filtered by: ${personName}`);
    } else {
      void this.plugin.activateView().then(() => {
        const leaves = workspace.getLeavesOfType(MONDAY_VIEW_TYPE);
        if (leaves.length > 0) {
          const mondayView = leaves[0].view;
          setTimeout(() => {
            mondayView.setPersonFilter(personName);
            new import_obsidian.Notice(`Filtered by: ${personName}`);
          }, 500);
        }
      });
    }
  }
  async onClose() {
  }
};
var DuplicateNoteModal = class extends import_obsidian.Modal {
  constructor(app, notePath, callback) {
    super(app);
    this.notePath = notePath;
    this.callback = callback;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("monday-duplicate-modal");
    contentEl.createEl("h3", { text: "Note already exists" });
    contentEl.createEl("p", { text: `A note already exists at:` });
    contentEl.createEl("code", { text: this.notePath, cls: "monday-modal-path" });
    contentEl.createEl("p", { text: "What would you like to do?" });
    const buttonContainer = contentEl.createEl("div", { cls: "monday-modal-buttons" });
    const openBtn = buttonContainer.createEl("button", { text: "Open existing note", cls: "mod-cta" });
    openBtn.addEventListener("click", () => {
      this.callback("open");
      this.close();
    });
    const createBtn = buttonContainer.createEl("button", { text: "Create new note" });
    createBtn.addEventListener("click", () => {
      this.callback("create");
      this.close();
    });
    const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.close();
    });
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
var AddCommentModal = class extends import_obsidian.Modal {
  constructor(app, itemName, callback) {
    super(app);
    this.itemName = itemName;
    this.callback = callback;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("monday-comment-modal");
    contentEl.createEl("h3", { text: "Add comment" });
    contentEl.createEl("p", { text: `Adding comment to: ${this.itemName}`, cls: "monday-comment-item-name" });
    const textArea = contentEl.createEl("textarea", {
      cls: "monday-comment-textarea",
      attr: { placeholder: "Enter your comment..." }
    });
    textArea.rows = 5;
    const buttonContainer = contentEl.createEl("div", { cls: "monday-modal-buttons" });
    const submitBtn = buttonContainer.createEl("button", { text: "Add comment", cls: "mod-cta" });
    submitBtn.addEventListener("click", () => {
      const comment = textArea.value.trim();
      if (comment) {
        this.callback(comment);
        this.close();
      } else {
        new import_obsidian.Notice("Please enter a comment");
      }
    });
    const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.callback(null);
      this.close();
    });
    setTimeout(() => textArea.focus(), 50);
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
var CreateSubtaskModal = class extends import_obsidian.Modal {
  constructor(app, parentItemName, callback) {
    super(app);
    this.parentItemName = parentItemName;
    this.callback = callback;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("monday-subtask-modal");
    contentEl.createEl("h3", { text: "Add subtask" });
    contentEl.createEl("p", { text: `Adding subtask to: ${this.parentItemName}`, cls: "monday-subtask-parent-name" });
    const inputEl = contentEl.createEl("input", {
      cls: "monday-subtask-input",
      attr: {
        type: "text",
        placeholder: "Enter subtask name..."
      }
    });
    const buttonContainer = contentEl.createEl("div", { cls: "monday-modal-buttons" });
    const submitBtn = buttonContainer.createEl("button", { text: "Create subtask", cls: "mod-cta" });
    submitBtn.addEventListener("click", () => {
      const subtaskName = inputEl.value.trim();
      if (subtaskName) {
        this.callback(subtaskName);
        this.close();
      } else {
        new import_obsidian.Notice("Please enter a subtask name");
      }
    });
    const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.callback(null);
      this.close();
    });
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const subtaskName = inputEl.value.trim();
        if (subtaskName) {
          this.callback(subtaskName);
          this.close();
        }
      }
    });
    setTimeout(() => inputEl.focus(), 50);
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
var AssignPersonModal = class extends import_obsidian.Modal {
  constructor(app, plugin, itemName, currentAssignees, callback) {
    super(app);
    this.users = [];
    this.selectedUserIds = /* @__PURE__ */ new Set();
    this.plugin = plugin;
    this.itemName = itemName;
    this.currentAssignees = currentAssignees;
    this.callback = callback;
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("monday-assign-modal");
    contentEl.createEl("h3", { text: "Assign person" });
    contentEl.createEl("p", { text: this.itemName, cls: "monday-assign-item-name" });
    if (this.currentAssignees.length > 0) {
      contentEl.createEl("p", {
        text: `Currently assigned: ${this.currentAssignees.join(", ")}`,
        cls: "monday-assign-current"
      });
    }
    const loadingEl = contentEl.createEl("div", { cls: "monday-loading" });
    loadingEl.createEl("div", { cls: "monday-spinner" });
    loadingEl.createEl("span", { text: "Loading users...", cls: "monday-loading-text" });
    try {
      this.users = await this.plugin.apiClient.getUsers();
      loadingEl.remove();
      const userListEl = contentEl.createEl("div", { cls: "monday-user-list" });
      for (const user of this.users) {
        const userEl = userListEl.createEl("div", { cls: "monday-user-item" });
        const checkbox = userEl.createEl("input", {
          attr: { type: "checkbox", id: `user-${user.id}` }
        });
        if (this.currentAssignees.some((a) => a.toLowerCase() === user.name.toLowerCase())) {
          checkbox.checked = true;
          this.selectedUserIds.add(parseInt(user.id));
        }
        checkbox.addEventListener("change", () => {
          const userId = parseInt(user.id);
          if (checkbox.checked) {
            this.selectedUserIds.add(userId);
          } else {
            this.selectedUserIds.delete(userId);
          }
        });
        const label = userEl.createEl("label", {
          text: user.name,
          attr: { for: `user-${user.id}` }
        });
        label.createEl("span", { text: ` (${user.email})`, cls: "monday-user-email" });
      }
      const buttonContainer = contentEl.createEl("div", { cls: "monday-modal-buttons" });
      const clearBtn = buttonContainer.createEl("button", { text: "Clear all" });
      clearBtn.addEventListener("click", () => {
        this.selectedUserIds.clear();
        userListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
          cb.checked = false;
        });
      });
      const submitBtn = buttonContainer.createEl("button", { text: "Assign", cls: "mod-cta" });
      submitBtn.addEventListener("click", () => {
        this.callback(Array.from(this.selectedUserIds));
        this.close();
      });
      const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
      cancelBtn.addEventListener("click", () => {
        this.callback(null);
        this.close();
      });
    } catch (error) {
      loadingEl.remove();
      contentEl.createEl("p", {
        text: `Error loading users: ${error instanceof Error ? error.message : "Unknown error"}`,
        cls: "monday-sidebar-error"
      });
    }
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
var CreateTaskModal = class extends import_obsidian.Modal {
  constructor(app, plugin, initialText = "") {
    super(app);
    this.selectedBoardId = "";
    this.selectedGroupId = "";
    this.groups = [];
    this.taskNameInput = null;
    this.groupDropdown = null;
    this.submitBtn = null;
    this.plugin = plugin;
    this.initialText = initialText;
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("monday-create-task-modal");
    contentEl.createEl("h3", { text: "Create Monday.com task" });
    const nameContainer = contentEl.createEl("div", { cls: "monday-modal-field" });
    nameContainer.createEl("label", { text: "Task name" });
    this.taskNameInput = nameContainer.createEl("input", {
      type: "text",
      cls: "monday-task-name-input",
      value: this.initialText
    });
    this.taskNameInput.placeholder = "Enter task name...";
    const boardContainer = contentEl.createEl("div", { cls: "monday-modal-field" });
    boardContainer.createEl("label", { text: "Board" });
    const boardDropdown = boardContainer.createEl("select", { cls: "monday-board-dropdown" });
    const defaultBoardOption = boardDropdown.createEl("option", { text: "Select a board...", value: "" });
    defaultBoardOption.disabled = true;
    defaultBoardOption.selected = true;
    for (const board of this.plugin.settings.cachedBoards) {
      const option = boardDropdown.createEl("option", { text: board.name, value: board.id });
      if (board.id === this.plugin.settings.defaultBoardId) {
        option.selected = true;
        this.selectedBoardId = board.id;
      }
    }
    boardDropdown.addEventListener("change", async () => {
      this.selectedBoardId = boardDropdown.value;
      await this.loadGroups();
    });
    const groupContainer = contentEl.createEl("div", { cls: "monday-modal-field" });
    groupContainer.createEl("label", { text: "Group" });
    this.groupDropdown = groupContainer.createEl("select", { cls: "monday-group-dropdown" });
    this.groupDropdown.disabled = true;
    const defaultGroupOption = this.groupDropdown.createEl("option", { text: "Select a board first...", value: "" });
    defaultGroupOption.disabled = true;
    defaultGroupOption.selected = true;
    this.groupDropdown.addEventListener("change", () => {
      this.selectedGroupId = this.groupDropdown.value;
      this.updateSubmitButton();
    });
    if (this.selectedBoardId) {
      await this.loadGroups();
    }
    const buttonContainer = contentEl.createEl("div", { cls: "monday-modal-buttons" });
    this.submitBtn = buttonContainer.createEl("button", { text: "Create task", cls: "mod-cta" });
    this.submitBtn.disabled = true;
    this.submitBtn.addEventListener("click", () => void this.createTask());
    const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    this.taskNameInput.addEventListener("input", () => this.updateSubmitButton());
    setTimeout(() => {
      var _a;
      return (_a = this.taskNameInput) == null ? void 0 : _a.focus();
    }, 50);
    this.updateSubmitButton();
  }
  async loadGroups() {
    if (!this.groupDropdown || !this.selectedBoardId)
      return;
    this.groupDropdown.empty();
    const loadingOption = this.groupDropdown.createEl("option", { text: "Loading groups...", value: "" });
    loadingOption.disabled = true;
    loadingOption.selected = true;
    this.groupDropdown.disabled = true;
    this.selectedGroupId = "";
    try {
      this.groups = await this.plugin.apiClient.getBoardGroups(this.selectedBoardId);
      this.groupDropdown.empty();
      if (this.groups.length === 0) {
        const noGroupsOption = this.groupDropdown.createEl("option", { text: "No groups found", value: "" });
        noGroupsOption.disabled = true;
        noGroupsOption.selected = true;
      } else {
        const selectOption = this.groupDropdown.createEl("option", { text: "Select a group...", value: "" });
        selectOption.disabled = true;
        selectOption.selected = true;
        for (const group of this.groups) {
          this.groupDropdown.createEl("option", { text: group.title, value: group.id });
        }
        this.groupDropdown.disabled = false;
      }
    } catch (error) {
      this.groupDropdown.empty();
      const errorOption = this.groupDropdown.createEl("option", { text: "Error loading groups", value: "" });
      errorOption.disabled = true;
      errorOption.selected = true;
      new import_obsidian.Notice(`Failed to load groups: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    this.updateSubmitButton();
  }
  updateSubmitButton() {
    if (!this.submitBtn || !this.taskNameInput)
      return;
    const hasTaskName = this.taskNameInput.value.trim().length > 0;
    const hasBoard = this.selectedBoardId.length > 0;
    const hasGroup = this.selectedGroupId.length > 0;
    this.submitBtn.disabled = !(hasTaskName && hasBoard && hasGroup);
  }
  async createTask() {
    if (!this.taskNameInput)
      return;
    const taskName = this.taskNameInput.value.trim();
    if (!taskName || !this.selectedBoardId || !this.selectedGroupId) {
      new import_obsidian.Notice("Please fill in all fields");
      return;
    }
    if (this.submitBtn) {
      this.submitBtn.disabled = true;
      this.submitBtn.textContent = "Creating...";
    }
    try {
      const result = await this.plugin.apiClient.createItem(
        this.selectedBoardId,
        this.selectedGroupId,
        taskName
      );
      if (result) {
        new import_obsidian.Notice(`Task created: ${result.name}`);
        this.close();
      } else {
        new import_obsidian.Notice("Failed to create task");
        if (this.submitBtn) {
          this.submitBtn.disabled = false;
          this.submitBtn.textContent = "Create task";
        }
      }
    } catch (error) {
      new import_obsidian.Notice(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
      if (this.submitBtn) {
        this.submitBtn.disabled = false;
        this.submitBtn.textContent = "Create Task";
      }
    }
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
var StatusBarManager = class {
  constructor(plugin) {
    this.statusBarEl = null;
    this.plugin = plugin;
  }
  enable() {
    if (this.statusBarEl)
      return;
    this.statusBarEl = this.plugin.addStatusBarItem();
    this.statusBarEl.addClass("monday-status-bar");
    this.statusBarEl.title = "Click to open Monday.com sidebar";
    this.statusBarEl.addEventListener("click", () => {
      void this.plugin.activateView();
    });
    void this.update();
  }
  async update() {
    if (!this.statusBarEl)
      return;
    if (!this.plugin.settings.apiToken) {
      this.statusBarEl.setText("Monday: Not configured");
      return;
    }
    const boardCount = this.plugin.settings.cachedBoards.length;
    const lastSync = this.plugin.settings.lastSync;
    let syncText = "Never synced";
    if (lastSync) {
      const minutes = Math.floor((Date.now() - lastSync) / 6e4);
      if (minutes < 1) {
        syncText = "Just now";
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
};
var MondaySettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("API configuration").setHeading();
    new import_obsidian.Setting(containerEl).setName("API token").setDesc("Your Monday.com API token. Get it from Monday.com > Profile > Developers > My Access Tokens").addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.addClass("monday-settings-input-wide");
      return text.setPlaceholder("Enter your API token").setValue(this.plugin.settings.apiToken).onChange(async (value) => {
        this.plugin.settings.apiToken = value;
        await this.plugin.saveSettings();
        this.plugin.apiClient = new MondayApiClient(value);
      });
    });
    new import_obsidian.Setting(containerEl).setName("Test connection").setDesc("Verify your API token works correctly").addButton((button) => button.setButtonText("Test").onClick(async () => {
      button.setButtonText("Testing...");
      button.setDisabled(true);
      const success = await this.plugin.apiClient.testConnection();
      if (success) {
        new import_obsidian.Notice("Connection successful!");
        button.setButtonText("Success!");
      } else {
        new import_obsidian.Notice("Connection failed. Check your API token.");
        button.setButtonText("Failed");
      }
      setTimeout(() => {
        button.setButtonText("Test");
        button.setDisabled(false);
      }, 2e3);
    }));
    new import_obsidian.Setting(containerEl).setName("Load boards").setDesc("Fetch your Monday.com boards").addButton((button) => button.setButtonText("Load boards").onClick(async () => {
      button.setButtonText("Loading...");
      button.setDisabled(true);
      try {
        const boards = await this.plugin.apiClient.getBoards();
        this.plugin.settings.cachedBoards = boards;
        this.plugin.settings.lastSync = Date.now();
        await this.plugin.saveSettings();
        new import_obsidian.Notice(`Loaded ${boards.length} boards`);
        this.display();
      } catch (error) {
        new import_obsidian.Notice(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
      button.setButtonText("Load boards");
      button.setDisabled(false);
    }));
    if (this.plugin.settings.cachedBoards.length > 0) {
      new import_obsidian.Setting(containerEl).setName("Default board").setDesc("Board to use when none is specified in code blocks").addDropdown((dropdown) => {
        dropdown.addOption("", "Select a board...");
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
    new import_obsidian.Setting(containerEl).setName("Display settings").setHeading();
    new import_obsidian.Setting(containerEl).setName("Show status bar").setDesc("Display Monday.com sync status in the status bar").addToggle((toggle) => toggle.setValue(this.plugin.settings.showStatusBar).onChange(async (value) => {
      this.plugin.settings.showStatusBar = value;
      await this.plugin.saveSettings();
      if (value) {
        this.plugin.statusBar.enable();
      } else {
        this.plugin.statusBar.disable();
      }
    }));
    new import_obsidian.Setting(containerEl).setName("Show status dropdown").setDesc("Display quick status change dropdown on sidebar items").addToggle((toggle) => toggle.setValue(this.plugin.settings.showStatusDropdown).onChange(async (value) => {
      this.plugin.settings.showStatusDropdown = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Auto-refresh interval").setDesc("How often to refresh data in minutes (0 to disable)").addText((text) => text.setPlaceholder("5").setValue(this.plugin.settings.refreshInterval.toString()).onChange(async (value) => {
      const num = parseInt(value) || 0;
      this.plugin.settings.refreshInterval = num;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Note creation").setHeading();
    new import_obsidian.Setting(containerEl).setName("Note folder").setDesc("Folder where notes created from Monday.com items will be saved").addText((text) => text.setPlaceholder("Monday").setValue(this.plugin.settings.noteFolder).onChange(async (value) => {
      this.plugin.settings.noteFolder = value || "Monday";
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Note name template").setDesc("Template for note names. Use {name}, {board}, {group}, {id} as placeholders").addText((text) => {
      text.inputEl.addClass("monday-settings-input-medium");
      return text.setPlaceholder("{name}").setValue(this.plugin.settings.noteNameTemplate).onChange(async (value) => {
        this.plugin.settings.noteNameTemplate = value || "{name}";
        await this.plugin.saveSettings();
      });
    });
    const templateExamples = containerEl.createEl("div", { cls: "monday-template-examples" });
    templateExamples.createEl("p", { text: "Examples:", cls: "monday-template-title" });
    const exampleList = templateExamples.createEl("ul");
    exampleList.createEl("li", { text: '{name} \u2192 "Fix login bug"' });
    exampleList.createEl("li", { text: '{board}/{name} \u2192 "Project Alpha/Fix login bug"' });
    exampleList.createEl("li", { text: '{group} - {name} \u2192 "Sprint 1 - Fix login bug"' });
    new import_obsidian.Setting(containerEl).setName("Usage").setHeading();
    const usageEl = containerEl.createEl("div", { cls: "monday-usage" });
    usageEl.createEl("p", { text: "Add a Monday.com dashboard to any note by inserting a code block:" });
    const codeExample = usageEl.createEl("pre");
    codeExample.createEl("code", {
      text: "```monday\nboard: YOUR_BOARD_ID\ntitle: My Tasks\nlimit: 25\n```"
    });
    usageEl.createEl("p", { text: "Options:" });
    const optionsList = usageEl.createEl("ul");
    optionsList.createEl("li", { text: "board: Board ID (required if no default set)" });
    optionsList.createEl("li", { text: "title: Custom title (optional)" });
    optionsList.createEl("li", { text: "limit: Max items to show (default: 25)" });
    optionsList.createEl("li", { text: "columns: Comma-separated column IDs to display" });
    new import_obsidian.Setting(containerEl).setName("Support this plugin").setHeading();
    const supportEl = containerEl.createEl("div", { cls: "monday-support" });
    supportEl.createEl("p", {
      text: "If this plugin helps you stay organised, consider buying me a coffee!"
    });
    const coffeeLink = supportEl.createEl("a", {
      href: "https://buymeacoffee.com/maframpton",
      cls: "monday-coffee-link"
    });
    coffeeLink.setAttr("target", "_blank");
    const coffeeImg = coffeeLink.createEl("img", {
      cls: "monday-coffee-button"
    });
    coffeeImg.setAttr("src", "https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png");
    coffeeImg.setAttr("alt", "Buy Me A Coffee");
    coffeeImg.setAttr("height", "50");
  }
};
var MondayIntegrationPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.currentBoardId = "";
  }
  // Shared board selection between views
  async onload() {
    console.debug("Loading Monday.com Integration plugin");
    await this.loadSettings();
    this.apiClient = new MondayApiClient(this.settings.apiToken);
    this.statusBar = new StatusBarManager(this);
    if (this.settings.showStatusBar) {
      this.statusBar.enable();
    }
    this.registerView(
      MONDAY_VIEW_TYPE,
      (leaf) => new MondayView(leaf, this)
    );
    this.registerView(
      MONDAY_TEAM_VIEW_TYPE,
      (leaf) => new MondayTeamView(leaf, this)
    );
    this.registerMarkdownCodeBlockProcessor(
      "monday",
      (source, el, ctx) => {
        const options = parseDashboardOptions(source);
        const renderer = new MondayDashboardRenderer(el, this, options);
        ctx.addChild(renderer);
      }
    );
    this.addRibbonIcon("calendar-check", "Open Monday.com", () => {
      void this.activateView();
    });
    this.addRibbonIcon("users", "Open Monday Team Summary", () => {
      void this.activateTeamView();
    });
    this.addCommand({
      id: "insert-monday-board",
      name: "Insert board dashboard",
      editorCallback: (editor) => {
        const boardId = this.settings.defaultBoardId || "YOUR_BOARD_ID";
        const block = `\`\`\`monday
board: ${boardId}
title: My Tasks
\`\`\`
`;
        editor.replaceSelection(block);
      }
    });
    this.addCommand({
      id: "open-monday-sidebar",
      name: "Open sidebar",
      callback: () => {
        void this.activateView();
      }
    });
    this.addCommand({
      id: "open-monday-team-summary",
      name: "Open team summary",
      callback: () => {
        void this.activateTeamView();
      }
    });
    this.addCommand({
      id: "refresh-monday-data",
      name: "Refresh boards",
      callback: async () => {
        if (!this.settings.apiToken) {
          new import_obsidian.Notice("Please configure your API token first");
          return;
        }
        try {
          new import_obsidian.Notice("Refreshing Monday.com boards...");
          const boards = await this.apiClient.getBoards();
          this.settings.cachedBoards = boards;
          this.settings.lastSync = Date.now();
          await this.saveSettings();
          void this.statusBar.update();
          new import_obsidian.Notice(`Loaded ${boards.length} boards`);
        } catch (error) {
          new import_obsidian.Notice(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
      }
    });
    this.addCommand({
      id: "create-monday-task",
      name: "Create Monday.com task",
      editorCallback: (editor) => {
        if (!this.settings.apiToken) {
          new import_obsidian.Notice("Please configure your Monday.com API token first");
          return;
        }
        if (this.settings.cachedBoards.length === 0) {
          new import_obsidian.Notice("Please load your Monday.com boards first (Settings > Monday.com Integration)");
          return;
        }
        const selection = editor.getSelection();
        new CreateTaskModal(this.app, this, selection).open();
      }
    });
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!this.settings.apiToken || this.settings.cachedBoards.length === 0) {
          return;
        }
        const selection = editor.getSelection();
        menu.addItem((item) => {
          item.setTitle(selection ? "Create Monday.com task from selection" : "Create Monday.com task").setIcon("calendar-check").onClick(() => {
            new CreateTaskModal(this.app, this, selection).open();
          });
        });
      })
    );
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
      workspace.revealLeaf(leaf);
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
      workspace.revealLeaf(leaf);
    }
  }
  // Sync board selection across all Monday views
  syncBoardSelection(boardId, sourceView) {
    this.currentBoardId = boardId;
    const { workspace } = this.app;
    if (sourceView === "team") {
      const mondayLeaves = workspace.getLeavesOfType(MONDAY_VIEW_TYPE);
      for (const leaf of mondayLeaves) {
        const view = leaf.view;
        view.setBoard(boardId);
      }
    }
    if (sourceView === "main") {
      const teamLeaves = workspace.getLeavesOfType(MONDAY_TEAM_VIEW_TYPE);
      for (const leaf of teamLeaves) {
        const view = leaf.view;
        view.setBoard(boardId);
      }
    }
  }
  onunload() {
    console.debug("Unloading Monday.com Integration plugin");
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
