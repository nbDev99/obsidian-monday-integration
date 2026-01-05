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
var MONDAY_API_URL = "https://api.monday.com/v2";
var DEFAULT_SETTINGS = {
  apiToken: "",
  defaultBoardId: "",
  refreshInterval: 5,
  showStatusBar: true,
  cachedBoards: [],
  lastSync: 0
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
    if (response.json.errors) {
      throw new Error(((_a = response.json.errors[0]) == null ? void 0 : _a.message) || "API error");
    }
    return response.json.data;
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
  constructor(leaf, plugin) {
    super(leaf);
    this.selectedBoardId = null;
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
    refreshBtn.innerHTML = "&#x21bb;";
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
      this.selectedBoardId = e.target.value;
      void this.renderBoardItems(container);
    });
    const itemsContainer = container.createEl("div", { cls: "monday-sidebar-items" });
    if (this.selectedBoardId) {
      await this.renderBoardItems(container);
    } else if (this.plugin.settings.cachedBoards.length === 0) {
      itemsContainer.createEl("p", { text: "Click refresh to load boards.", cls: "monday-sidebar-hint" });
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
  async renderBoardItems(parentContainer) {
    var _a, _b;
    const container = parentContainer;
    let itemsContainer = container.querySelector(".monday-sidebar-items");
    if (!itemsContainer) {
      itemsContainer = container.createEl("div", { cls: "monday-sidebar-items" });
    }
    itemsContainer.empty();
    if (!this.selectedBoardId)
      return;
    itemsContainer.createEl("div", { text: "Loading items...", cls: "monday-sidebar-loading" });
    try {
      const boardData = await this.plugin.apiClient.getBoardData(this.selectedBoardId, 50);
      itemsContainer.empty();
      if (!boardData) {
        itemsContainer.createEl("p", { text: "Board not found." });
        return;
      }
      if (boardData.items.length === 0) {
        itemsContainer.createEl("p", { text: "No items in this board." });
        return;
      }
      const groupedItems = /* @__PURE__ */ new Map();
      for (const item of boardData.items) {
        const groupName = ((_a = item.group) == null ? void 0 : _a.title) || "No Group";
        if (!groupedItems.has(groupName)) {
          groupedItems.set(groupName, []);
        }
        groupedItems.get(groupName).push(item);
      }
      for (const [groupName, items] of groupedItems) {
        const groupEl = itemsContainer.createEl("div", { cls: "monday-sidebar-group" });
        groupEl.createEl("div", { text: groupName, cls: "monday-sidebar-group-title" });
        for (const item of items) {
          const itemEl = groupEl.createEl("div", { cls: "monday-sidebar-item" });
          itemEl.createEl("span", { text: item.name, cls: "monday-sidebar-item-name" });
          const statusCol = item.column_values.find((cv) => {
            const col = boardData.columns.find((c) => c.id === cv.id);
            return (col == null ? void 0 : col.type) === "status";
          });
          if (statusCol == null ? void 0 : statusCol.text) {
            const statusBadge = itemEl.createEl("span", {
              text: statusCol.text,
              cls: "monday-sidebar-status"
            });
            try {
              const valueObj = statusCol.value ? JSON.parse(statusCol.value) : null;
              if ((_b = valueObj == null ? void 0 : valueObj.label_style) == null ? void 0 : _b.color) {
                statusBadge.style.backgroundColor = valueObj.label_style.color;
              }
            } catch (e) {
            }
          }
        }
      }
    } catch (error) {
      itemsContainer.empty();
      itemsContainer.createEl("p", {
        text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        cls: "monday-sidebar-error"
      });
    }
  }
  async onClose() {
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
      text.inputEl.style.width = "300px";
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
    new import_obsidian.Setting(containerEl).setName("Auto-refresh interval").setDesc("How often to refresh data in minutes (0 to disable)").addText((text) => text.setPlaceholder("5").setValue(this.plugin.settings.refreshInterval.toString()).onChange(async (value) => {
      const num = parseInt(value) || 0;
      this.plugin.settings.refreshInterval = num;
      await this.plugin.saveSettings();
    }));
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
