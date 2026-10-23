-- Full-text search over what was said in chats and written in notes (SPEC §9.16), SQLite FTS5.
-- kind: user | message | note. ref: turn id, "chatId:seq", or node id.
CREATE VIRTUAL TABLE `search` USING fts5(`kind` UNINDEXED, `ref` UNINDEXED, `chat_id` UNINDEXED, `body`, tokenize = 'unicode61 remove_diacritics 2');
--> statement-breakpoint
INSERT INTO `search` (`kind`, `ref`, `chat_id`, `body`) SELECT 'user', `id`, `chat_id`, `user_text` FROM `turns`;
--> statement-breakpoint
INSERT INTO `search` (`kind`, `ref`, `chat_id`, `body`)
  SELECT 'message', `chat_id` || ':' || `seq`, `chat_id`, json_extract(`payload_json`, '$.text') FROM `events` WHERE `type` = 'message.completed';
--> statement-breakpoint
INSERT INTO `search` (`kind`, `ref`, `chat_id`, `body`)
  SELECT 'note', `id`, NULL, json_extract(`data_json`, '$.text') FROM `nodes` WHERE `type` = 'note';
