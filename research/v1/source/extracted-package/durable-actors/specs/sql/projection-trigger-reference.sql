-- LOCAL SQL EXPERIMENT ONLY. Runtime discovery, ordering, versions and fences omitted.
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  done INTEGER NOT NULL CHECK (done IN (0, 1))
);
CREATE TABLE _da_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  key_before TEXT,
  key_after TEXT,
  before_json TEXT,
  after_json TEXT
);
CREATE TRIGGER todos_capture_insert AFTER INSERT ON todos BEGIN
  INSERT INTO _da_changes(operation, key_after, after_json)
  VALUES ('insert', NEW.id, json_object('id', NEW.id, 'projectId', NEW.project_id, 'title', NEW.title, 'done', NEW.done));
END;
CREATE TRIGGER todos_capture_update AFTER UPDATE ON todos BEGIN
  INSERT INTO _da_changes(operation, key_before, key_after, before_json, after_json)
  VALUES ('update', OLD.id, NEW.id,
    json_object('id', OLD.id, 'projectId', OLD.project_id, 'title', OLD.title, 'done', OLD.done),
    json_object('id', NEW.id, 'projectId', NEW.project_id, 'title', NEW.title, 'done', NEW.done));
END;
CREATE TRIGGER todos_capture_delete AFTER DELETE ON todos BEGIN
  INSERT INTO _da_changes(operation, key_before, before_json)
  VALUES ('delete', OLD.id, json_object('id', OLD.id, 'projectId', OLD.project_id, 'title', OLD.title, 'done', OLD.done));
END;
