const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const db = new Database("game.db");

const JWT_SECRET = "nanli_change_this_to_a_long_random_secret_123456";

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rankings (
  user_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  power INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  vip INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "未登录或登录已过期" });
  }
}

app.post("/api/register", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(username)) {
    return res.status(400).json({
      error: "用户名需为2-16位中文、英文、数字或下划线"
    });
  }

  if (password.length < 6 || password.length > 32) {
    return res.status(400).json({
      error: "密码需为6-32位"
    });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, created_at)
      VALUES (?, ?, ?)
    `).run(username, passwordHash, Date.now());

    const token = jwt.sign(
      { id: info.lastInsertRowid, username },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({ token, username });
  } catch {
    res.status(409).json({ error: "用户名已存在" });
  }
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  const user = db.prepare(`
    SELECT * FROM users WHERE username = ?
  `).get(username);

  if (!user) {
    return res.status(401).json({ error: "账号或密码错误" });
  }

  const ok = await bcrypt.compare(password, user.password_hash);

  if (!ok) {
    return res.status(401).json({ error: "账号或密码错误" });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.json({ token, username: user.username });
});

app.post("/api/ranking", auth, (req, res) => {
  const power = Math.max(0, Math.floor(Number(req.body.power) || 0));
  const level = Math.max(1, Math.floor(Number(req.body.level) || 1));
  const vip = Math.max(0, Math.floor(Number(req.body.vip) || 0));

  db.prepare(`
    INSERT INTO rankings (user_id, username, power, level, vip, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      power = excluded.power,
      level = excluded.level,
      vip = excluded.vip,
      updated_at = excluded.updated_at
  `).run(req.user.id, req.user.username, power, level, vip, Date.now());

  res.json({ ok: true });
});

app.get("/api/ranking", (req, res) => {
  const rows = db.prepare(`
    SELECT username, power, level, vip, updated_at
    FROM rankings
    ORDER BY power DESC, level DESC, vip DESC
    LIMIT 50
  `).all();

  res.json(rows);
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "game.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("服务器已启动，端口：" + PORT);
});