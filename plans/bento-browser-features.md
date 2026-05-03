# Bento Browser – Feature Plan

> High-level feature plan and roadmap for a Firefox-based Bento Browser built with Surfer, focusing on a custom UI shell, performance, and privacy.

---

## 1. Product Pillars

1. **Workspace-first browsing**  
   - Multiple named workspaces ("bento boxes") grouping tabs, windows and layouts by context (Work, Personal, Research, etc.).  
   - Quick switching between workspaces with keyboard and UI affordances.

2. **Panel-based multi-pane layouts**  
   - Unlimited resizable panels in a workspace, arranged left-to-right.  
   - Drag-and-drop reordering and intuitive push-based resizing.

3. **Vertical tabs and focused navigation**  
   - Vertical tab strip with rich metadata (icons, titles, preview on hover).  
   - Designed for large tab counts and multi-row / grouped views.

4. **Performance and stability on par with Firefox**  
   - Stay close to upstream Firefox engine and networking.  
   - Light UI layer (privileged extensions + minimal patches) to avoid regressions.

5. **Opinionated privacy defaults**  
   - Strong tracking protection, sane defaults, and transparent configuration.  
   - Minimal outbound telemetry, clear documentation on bentobrowser.app.

---

## 2. Feature Groups and Specifications

### 2.1 Workspaces ("Bento Boxes")

**Goals**  
Give users separate, persistent contexts for different tasks, each with its own tabs, layouts, and settings.

**Core Features**

- Named workspaces with colour and icon per workspace.
- Workspace switcher UI in the main chrome (sidebar or top bar).
- Keyboard shortcuts for switching (e.g. Ctrl/Cmd + number, or configurable).
- Workspace-level settings (default homepage, theme, privacy mode).
- Workspace persistence: restore last state on browser restart.

**Implementation Notes**

- Implement primarily in the `bento-shell` privileged extension (background script + UI components).
- Store workspace metadata in profile storage (JSON database or Firefox storage APIs).
- Use standard Firefox window and tab APIs; avoid deep engine modifications.

**Priority / Milestone**

- Priority: P0 (critical to Bento identity).  
- Target: M1 – Developer Preview.

---

### 2.2 Vertical Tabs and Tab Management

**Goals**  
Optimise for large tab counts and widescreen monitors by moving tab navigation to a vertical sidebar.

**Core Features**

- Vertical tab strip on left (default) with optional right placement. 
- Tab grouping / nesting (optional for later milestone). 
- Tab thumbnails on hover and/or compact mode with only favicons. 
- Indicators for audio, pin status, and container identity.

**Implementation Notes**

- UI rendered by `bento-shell` in a privileged sidebar or custom chrome region. 
- Sync with native Firefox tab model (open, close, move, pin) via standard APIs. 
- Minimal or no modification to Firefox’s internal tab handling; hide or minimise the default horizontal tab strip via CSS + targeted patches.

**Priority / Milestone**

- Priority: P0.  
- Target: M1 – Developer Preview (vertical tabs), M2 – Public Beta (grouping, thumbnails).

---

### 2.3 Bento Spaces and Panel-Based Layouts

**Goals**  
Provide a panel-based browsing experience where each tab can live in its own resizable panel, arranged from left to right, supporting an effectively unlimited number of panels per workspace.

**Core Concepts**

- **Unlimited panels per workspace**  
  - A workspace (“Bento space”) can contain any number of panels (1–N).  
  - Each panel hosts a single active tab (with the ability to open links in the same panel or in a new panel to the right).

- **Left-to-right panel flow**  
  - Panels are laid out horizontally from left to right.  
  - New panels are created to the **right** of the currently focused panel by default.

- **Drag-to-reorder panels**  
  - Panels can be reordered by dragging their header/handle left or right.  
  - Reordering updates the logical order of panels as well as their visual position.

**Resizing Behaviour**

- Each panel boundary exposes a **drag handle** between two panels.  
- When the user drags a handle:  
  - Only the panel **to the left of the handle** is resized (width increases or decreases).  
  - Panels to the **right of the handle keep their widths**; instead, they are pushed left or right as a block to accommodate the change.  
  - The total layout always fills the available horizontal space; when a panel grows, the rightmost area may scroll horizontally if needed.

**Additional UX Details**

- Minimum and maximum width constraints per panel (e.g. min 240px, optional compact widths).  
- Optional horizontal scrolling if panels extend beyond viewport width.  
- Quick actions per panel: move to another workspace, pop out to a new window, close panel.

**Implementation Notes**

- Layout engine for Bento spaces should:  
  - Represent panels as an ordered list with explicit widths (percentages or px).  
  - Apply width changes only to the target panel; reflow other panels by pushing them, not by resizing them.
- Likely implemented using a custom HTML/CSS layout inside Bento’s chrome UI, with:  
  - Per-panel containers embedding browser views.  
  - Drag handles that update panel widths on drag events.
- Keep logic inside `bento-shell` so behaviour is decoupled from upstream Firefox layout changes.

**Priority / Milestone**

- Priority: P0 (signature layout mechanic).  
- Target:  
  - M2 – Public Beta: unlimited panels, drag-to-reorder, basic push-based resizing.  
  - M3 – v1 Stable: polished behaviour, smooth animations, horizontal scroll handling.

---

### 2.4 Command Palette and Global Actions

**Goals**  
Offer a keyboard-first interface for navigation, search, and commands, similar to modern editors and browsers.

**Core Features**

- Command palette invoked via keyboard shortcut (e.g. Ctrl/Cmd + K). 
- Commands for: open tab, switch workspace, search history, toggle layouts, run quick actions (clear site data, open devtools, etc.). 
- Fuzzy search over tabs, bookmarks, and commands.

**Implementation Notes**

- Purely UI/extension-level feature inside `bento-shell`. 
- Use built-in APIs to query tabs, history, bookmarks. 
- Command registry in `bento-shell` to make adding actions easy.

**Priority / Milestone**

- Priority: P1.  
- Target: M2 – Public Beta.

---

### 2.5 Session and Startup Behaviour

**Goals**  
Make Bento feel reliable and resume-friendly, especially across many tabs and workspaces.

**Core Features**

- Per-workspace session restore (tabs, layout, active pane). 
- Manual named sessions (save/restore under custom labels). 
- Startup options: reopen last session, open a specific workspace set, or go to a clean slate.

**Implementation Notes**

- Leverage Firefox’s session store where possible; layer workspace logic on top. 
- Persist additional Bento metadata (layout, workspace mapping) in profile storage. 
- Ensure failure modes are safe (e.g. corrupted Bento metadata falls back to vanilla Firefox restore).

**Priority / Milestone**

- Priority: P1.  
- Target: M2 – Public Beta.

---

### 2.6 Privacy and Security Defaults

**Goals**  
Ship Bento with strong, transparent defaults that are at least as protective as Firefox, preferably better, without breaking too many sites.

**Core Features**

- Strong tracking protection mode enabled by default. 
- Third-party cookie restrictions and fingerprinting resistance tuned for usability. 
- Minimal telemetry: disable most Mozilla telemetry; any Bento telemetry must be opt-in and clearly documented. 
- Easy access to per-site permissions and a privacy dashboard.

**Implementation Notes**

- Configure via default prefs in the Bento branding package. 
- If replacing Mozilla endpoints (SafeBrowsing, telemetry, etc.), do so via prefs and clearly disclose in docs. 
- Consider bundling a pre-configured content-blocking extension if needed.

**Priority / Milestone**

- Priority: P0.  
- Target: M1 – Developer Preview (baseline defaults), M2 – Public Beta (dashboard).

---

### 2.7 Performance and Resource Management

**Goals**  
Keep Bento responsive with many tabs and workspaces, especially on mid-range hardware.

**Core Features**

- Tab sleeping / auto-discarding inactive tabs per workspace. 
- Visual indicators for heavy tabs (CPU/network usage hints). 
- Workspace-level resource policies (e.g. aggressive sleeping on a "Research" workspace).

**Implementation Notes**

- Use existing tab discard APIs and memory hints where available. 
- Implement policies and UI in `bento-shell`; avoid modifying core scheduling in Gecko.

**Priority / Milestone**

- Priority: P1.  
- Target: M3 – v1 Stable.

---

### 2.8 Firefox Compatibility and Integration

**Goals**  
Remain a "true fork" with minimal surprises for Firefox users and extension developers.

**Core Features**

- Full support for standard Firefox WebExtensions. 
- Firefox Sync support (where licensing and product direction allow). 
- Ability to import Firefox profiles or at least bookmarks, history, and passwords.

**Implementation Notes**

- Stay close to upstream Firefox source; avoid changing core WebExtension APIs. 
- Limit deep changes to chrome UI and keep patches small and well-documented. 
- Respect licensing and branding requirements when using Mozilla services.

**Priority / Milestone**

- Priority: P0.  
- Target: M1 – Developer Preview (extensions), M3 – v1 Stable (import flows polished).

---

## 3. Milestones and Roadmap

### Milestone M0 – Internal Prototype

- Barebones Surfer-based build of Firefox with Bento branding. 
- `bento-shell` extension scaffolded; can open, close, and list tabs. 
- Experimental vertical tabs in a side panel.

### Milestone M1 – Developer Preview

Focus: core identity features working end-to-end.

- Workspaces (create/rename/switch, basic persistence). 
- Vertical tabs as the primary navigation UI. 
- Basic privacy defaults and Bento branding. 
- Extension compatibility validated with a small set of popular extensions. 
- Released via GitHub and linked on a simple `bentobrowser.app` landing page.

### Milestone M2 – Public Beta

Focus: layout power, usability, and polish.

- Bento spaces with unlimited panels, drag-to-reorder, and basic push-based resizing. 
- Command palette with core commands (navigation, workspace, search). 
- Session and startup options (per-workspace restore, simple saved sessions). 
- Privacy dashboard and clearer settings for tracking protection. 
- Stabilised Surfer and Firefox version tracking process.

### Milestone M3 – v1 Stable

Focus: robustness, performance, and docs.

- Polished panel behaviour (animations, horizontal scroll handling, smart defaults). 
- Resource management (tab sleeping policies, simple performance indicators). 
- Import flows for Firefox data (bookmarks, history, passwords). 
- Documentation and onboarding on `bentobrowser.app` (tutorials, keyboard shortcuts, FAQ). 
- Automated test coverage for core flows (workspace switch, panel changes, startup/restore).

---

## 4. Non-Goals for v1

- Full replacement of all Firefox UI components (focus on shell, not total redesign). 
- Custom rendering engine or major changes to Gecko/SpiderMonkey internals. 
- Heavy cloud services tightly coupled to Bento (keep accounts/services optional). 
- Native mobile versions (focus on desktop initially).
