-- TaskBoard schema for local development
-- In production, each service runs CREATE TABLE IF NOT EXISTS on startup.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS boards (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS board_columns (
  id         SERIAL PRIMARY KEY,
  board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name       VARCHAR(50) NOT NULL,
  color      VARCHAR(20),
  position   INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (board_id, position)
);

CREATE TABLE IF NOT EXISTS tasks (
  id               SERIAL PRIMARY KEY,
  column_id        INTEGER NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  title            VARCHAR(200) NOT NULL,
  description      TEXT,
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deadline         TIMESTAMP,
  priority         VARCHAR(10) NOT NULL DEFAULT 'medium',
  position         INTEGER NOT NULL,
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subtasks (
  id               SERIAL PRIMARY KEY,
  parent_task_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title            VARCHAR(200) NOT NULL,
  description      TEXT,
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deadline         TIMESTAMP,
  completed        BOOLEAN NOT NULL DEFAULT FALSE,
  position         INTEGER NOT NULL,
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_boards_owner        ON boards(owner_id);
CREATE INDEX IF NOT EXISTS idx_columns_board       ON board_columns(board_id);
CREATE INDEX IF NOT EXISTS idx_tasks_column        ON tasks(column_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_parent     ON subtasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_assignee   ON subtasks(assigned_user_id);
