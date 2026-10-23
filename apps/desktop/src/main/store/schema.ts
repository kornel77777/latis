import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// SPEC §7.1, M0 subset. Later milestones add their tables via new migrations.

export const canvases = sqliteTable("canvases", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
  viewportJson: text("viewport_json"),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  folderPath: text("folder_path").notNull(),
  createdAt: integer("created_at").notNull(),
  archivedAt: integer("archived_at"),
});

export const nodes = sqliteTable(
  "nodes",
  {
    id: text("id").primaryKey(),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    projectId: text("project_id"),
    parentId: text("parent_id"),
    type: text("type").notNull(),
    x: real("x").notNull(),
    y: real("y").notNull(),
    w: real("w").notNull(),
    h: real("h").notNull(),
    z: integer("z").notNull().default(0),
    dataJson: text("data_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("nodes_canvas").on(t.canvasId)],
);

export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  nodeId: text("node_id")
    .notNull()
    .references(() => nodes.id),
  agentId: text("agent_id").notNull(),
  model: text("model"),
  reasoning: text("reasoning"),
  permissionMode: text("permission_mode").notNull().default("auto-edit"),
  cwd: text("cwd").notNull(),
  worktreeId: text("worktree_id"),
  nativeSessionId: text("native_session_id"),
  title: text("title").notNull(),
  titleLocked: integer("title_locked", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("idle"),
  createdAt: integer("created_at").notNull(),
  lastActivityAt: integer("last_activity_at").notNull(),
});

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id),
    seq: integer("seq").notNull(),
    userText: text("user_text").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    status: text("status").notNull().default("running"),
    checkpointBefore: text("checkpoint_before"),
    checkpointAfter: text("checkpoint_after"),
  },
  (t) => [index("turns_chat").on(t.chatId, t.seq)],
);

export const events = sqliteTable(
  "events",
  {
    chatId: text("chat_id").notNull(),
    seq: integer("seq").notNull(),
    ts: integer("ts").notNull(),
    turnId: text("turn_id"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.seq] })],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

// SPEC §7.1 `attention`, plus `data_json` (summary + request details) so the Inbox can act without loading transcripts.
export const attention = sqliteTable(
  "attention",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    kind: text("kind").notNull(),
    refId: text("ref_id"),
    dataJson: text("data_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [index("attention_open").on(t.resolvedAt, t.createdAt)],
);
