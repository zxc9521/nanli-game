const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const db = new Database("game.db");

const JWT_SECRET = "nanli_change_this_to_a_long_random_secret_123456";
const GM_SECRET = "010212zp";
const GM_USERS = new Set([
  "我是南黎我是傻逼"
]);

app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  save_data TEXT,
  save_updated_at INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  leader_user_id INTEGER NOT NULL,
  leader_username TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_members (
  user_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  guild_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  FOREIGN KEY(guild_id) REFERENCES guilds(id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  from_user_id INTEGER NOT NULL,
  from_username TEXT NOT NULL,
  to_user_id INTEGER,
  to_username TEXT,
  guild_id INTEGER,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

const userColumns = db.prepare(`PRAGMA table_info(users)`).all().map(col => col.name);

if (!userColumns.includes("save_data")) {
  db.exec(`ALTER TABLE users ADD COLUMN save_data TEXT`);
}

if (!userColumns.includes("save_updated_at")) {
  db.exec(`ALTER TABLE users ADD COLUMN save_updated_at INTEGER NOT NULL DEFAULT 0`);
}

if (!userColumns.includes("banned")) {
  db.exec(`ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0`);
}
if (!userColumns.includes("muted_until")) {
  db.exec(`ALTER TABLE users ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0`);
}

const lastChatTime = new Map();

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    const user = db.prepare(`
      SELECT id, username, banned
      FROM users
      WHERE id = ?
    `).get(payload.id);

    if (!user) {
      return res.status(401).json({ error: "账号不存在" });
    }

    if (user.banned) {
      return res.status(403).json({ error: "账号已被封禁" });
    }

    req.user = {
      id: user.id,
      username: user.username
    };

    next();
  } catch {
    res.status(401).json({ error: "未登录或登录已过期" });
  }
}

function gmAuth(req, res, next) {
  const secret = String(req.headers["x-gm-secret"] || "");

  if (secret !== GM_SECRET) {
    return res.status(403).json({ error: "GM密钥错误" });
  }

  next();
}

function cleanText(text, max = 80) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function isGameGM(username) {
  return GAME_GM_USERS.has(String(username || ""));
}

function addGMFlag(row) {
  return {
    ...row,
    from_is_gm: isGameGM(row.from_username) ? 1 : 0,
    to_is_gm: isGameGM(row.to_username) ? 1 : 0
  };
}

function addAnnouncement(text) {
  db.prepare(`
    INSERT INTO announcements (text, created_at)
    VALUES (?, ?)
  `).run(text, Date.now());

  db.prepare(`
    DELETE FROM announcements
    WHERE id NOT IN (
      SELECT id
      FROM announcements
      ORDER BY id DESC
      LIMIT 50
    )
  `).run();
}

function gmCommandError(message, status = 400) {
  return {
    handled: true,
    status,
    body: {
      ok: false,
      command: true,
      error: message
    }
  };
}

function gmCommandOk(message) {
  return {
    handled: true,
    status: 200,
    body: {
      ok: true,
      command: true,
      message
    }
  };
}

function handleGMCommand(username, text, target = null) {
  const content = String(text || "").trim();

  const isCommand =
    /^JY\s+/i.test(content) ||
    /^JJY$/i.test(content) ||
    /^FH$/i.test(content) ||
    /^JFH$/i.test(content) ||
    /^GG\s+/i.test(content);

  if (!isCommand) {
    return {
      handled: false
    };
  }

  if (!isGameGM(username)) {
    return gmCommandError("你没有GM权限，无法使用GM指令", 403);
  }

  const ggMatch = content.match(/^GG\s+(.+)$/i);

  if (ggMatch) {
    const announcementText = cleanText(ggMatch[1], 100);

    if (!announcementText) {
      return gmCommandError("公告内容不能为空");
    }

    addAnnouncement(`【GM公告】${announcementText}`);

    return gmCommandOk(`全服公告已发布：${announcementText}`);
  }

  if (!target) {
    return gmCommandError("该GM指令需要指定私聊对象");
  }

  const jyMatch = content.match(/^JY\s+(\d{1,7})$/i);

  if (jyMatch) {
    if (isGameGM(target.username)) {
      return gmCommandError("不能禁言GM账号", 403);
    }

    const seconds = Math.max(1, Math.min(7 * 86400, Math.floor(Number(jyMatch[1]) || 0)));
    const mutedUntil = Date.now() + seconds * 1000;

    db.prepare(`
      UPDATE users
      SET muted_until = ?
      WHERE id = ?
    `).run(mutedUntil, target.id);

    addAnnouncement(`玩家 ${target.username} 已被GM ${username} 禁言 ${seconds} 秒`);

    return gmCommandOk(`${target.username} 已被禁言 ${seconds} 秒`);
  }

  if (/^JJY$/i.test(content)) {
    db.prepare(`
      UPDATE users
      SET muted_until = 0
      WHERE id = ?
    `).run(target.id);

    addAnnouncement(`玩家 ${target.username} 已被GM ${username} 解除禁言`);

    return gmCommandOk(`${target.username} 已解除禁言`);
  }

  if (/^FH$/i.test(content)) {
    if (isGameGM(target.username)) {
      return gmCommandError("不能封禁GM账号", 403);
    }

    db.prepare(`
      UPDATE users
      SET banned = 1
      WHERE id = ?
    `).run(target.id);

    db.prepare(`
      DELETE FROM rankings
      WHERE user_id = ?
    `).run(target.id);

    addAnnouncement(`玩家 ${target.username} 已被GM ${username} 封禁`);

    return gmCommandOk(`${target.username} 已被封禁，并已从排行榜移除`);
  }

  if (/^JFH$/i.test(content)) {
    db.prepare(`
      UPDATE users
      SET banned = 0
      WHERE id = ?
    `).run(target.id);

    addAnnouncement(`玩家 ${target.username} 已被GM ${username} 解除封禁`);

    return gmCommandOk(`${target.username} 已解除封禁`);
  }

  return gmCommandError("GM指令格式错误");
}
function checkMuted(userId) {
  const user = db.prepare(`
    SELECT muted_until
    FROM users
    WHERE id = ?
  `).get(userId);

  const mutedUntil = Number(user?.muted_until || 0);

  if (mutedUntil > Date.now()) {
    return {
      muted: true,
      mutedUntil
    };
  }

  return {
    muted: false,
    mutedUntil: 0
  };
}
function checkChatRate(userId) {
  const now = Date.now();
  const last = lastChatTime.get(userId) || 0;

  if (now - last < 3000) {
    return false;
  }

  lastChatTime.set(userId, now);
  return true;
}

function readUserSaveById(userId) {
  const user = db.prepare(`
    SELECT id, username, save_data
    FROM users
    WHERE id = ?
  `).get(userId);

  if (!user) {
    return { error: "玩家不存在" };
  }

  let save = null;

  try {
    save = user.save_data ? JSON.parse(user.save_data) : null;
  } catch {
    save = null;
  }

  if (!save || typeof save !== "object") {
    return {
      error: "该玩家暂无云存档，请先登录并保存一次"
    };
  }

  return { user, save };
}

function readUserSave(username) {
  const user = db.prepare(`
    SELECT id, username, save_data
    FROM users
    WHERE username = ?
  `).get(username);

  if (!user) {
    return { error: "玩家不存在" };
  }

  let save = null;

  try {
    save = user.save_data ? JSON.parse(user.save_data) : null;
  } catch {
    save = null;
  }

  if (!save || typeof save !== "object") {
    return {
      error: "该玩家暂无云存档，请让玩家先登录并保存一次"
    };
  }

  return { user, save };
}

function writeUserSave(userId, save) {
  save.last = Date.now();

  db.prepare(`
    UPDATE users
    SET save_data = ?, save_updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(save), Date.now(), userId);
}

function getMyGuild(userId) {
  return db.prepare(`
    SELECT
      gm.user_id,
      gm.username,
      gm.guild_id,
      gm.role,
      gm.joined_at,
      g.name AS guild_name,
      g.leader_user_id,
      g.leader_username,
      g.created_at
    FROM guild_members gm
    JOIN guilds g ON g.id = gm.guild_id
    WHERE gm.user_id = ?
  `).get(userId);
}

function trimChatTable() {
  db.prepare(`
    DELETE FROM chat_messages
    WHERE id NOT IN (
      SELECT id
      FROM chat_messages
      ORDER BY id DESC
      LIMIT 500
    )
  `).run();
}

/* =========================
   账号系统
========================= */

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
    SELECT *
    FROM users
    WHERE username = ?
  `).get(username);

  if (!user) {
    return res.status(401).json({ error: "账号或密码错误" });
  }

  if (user.banned) {
    return res.status(403).json({ error: "账号已被封禁" });
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

/* =========================
   云存档
========================= */

app.get("/api/save", auth, (req, res) => {
  const user = db.prepare(`
    SELECT save_data, save_updated_at
    FROM users
    WHERE id = ?
  `).get(req.user.id);

  if (!user || !user.save_data) {
    return res.json({
      save: null,
      updatedAt: 0
    });
  }

  try {
    res.json({
      save: JSON.parse(user.save_data),
      updatedAt: user.save_updated_at || 0
    });
  } catch {
    res.json({
      save: null,
      updatedAt: 0
    });
  }
});

app.post("/api/save", auth, (req, res) => {
  const save = req.body.save;
  const updatedAt = Math.max(0, Math.floor(Number(req.body.updatedAt) || Date.now()));

  if (!save || typeof save !== "object" || Array.isArray(save)) {
    return res.status(400).json({ error: "存档格式错误" });
  }

  const saveText = JSON.stringify(save);

  if (saveText.length > 8 * 1024 * 1024) {
    return res.status(400).json({ error: "存档太大，请先清理背包" });
  }

  db.prepare(`
    UPDATE users
    SET save_data = ?, save_updated_at = ?
    WHERE id = ?
  `).run(saveText, updatedAt, req.user.id);

  res.json({ ok: true });
});

/* =========================
   排行榜
========================= */

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

/* =========================
   全服通报
========================= */

app.post("/api/announcement", auth, (req, res) => {
  const text = cleanText(req.body.text, 120);

  if (!text) {
    return res.status(400).json({ error: "通报内容错误" });
  }

  db.prepare(`
    INSERT INTO announcements (text, created_at)
    VALUES (?, ?)
  `).run(text, Date.now());

  db.prepare(`
    DELETE FROM announcements
    WHERE id NOT IN (
      SELECT id
      FROM announcements
      ORDER BY id DESC
      LIMIT 50
    )
  `).run();

  res.json({ ok: true });
});

app.get("/api/announcement", (req, res) => {
  const since = Math.max(0, Math.floor(Number(req.query.since) || 0));

  const rows = db.prepare(`
    SELECT id, text, created_at
    FROM announcements
    WHERE id > ?
    ORDER BY id ASC
    LIMIT 20
  `).all(since);

  res.json(rows);
});

/* =========================
   世界聊天
========================= */

app.post("/api/chat/world/send", auth, (req, res) => {
  const text = cleanText(req.body.text, 80);

  if (!text) {
    return res.status(400).json({ error: "聊天内容不能为空" });
  }
const gmResult = handleGMCommand(req.user.username, text, null);
  if (gmResult.handled) {
    return res.status(gmResult.status).json(gmResult.body);
  }

const mute = checkMuted(req.user.id);
if (mute.muted) {
  return res.status(403).json({
    error: "你已被禁言，解禁时间：" + new Date(mute.mutedUntil).toLocaleString()
  });
}
  if (!checkChatRate(req.user.id)) {
    return res.status(429).json({ error: "发言太快，请3秒后再试" });
  }

  const info = db.prepare(`
    INSERT INTO chat_messages (
      type, from_user_id, from_username, text, created_at
    )
    VALUES ('world', ?, ?, ?, ?)
  `).run(req.user.id, req.user.username, text, Date.now());

  db.prepare(`
    DELETE FROM chat_messages
    WHERE type = 'world'
      AND id NOT IN (
        SELECT id
        FROM chat_messages
        WHERE type = 'world'
        ORDER BY id DESC
        LIMIT 20
      )
  `).run();

  trimChatTable();

  res.json({
    ok: true,
    id: info.lastInsertRowid
  });
});

app.get("/api/chat/world/list", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, type, from_username, text, created_at
    FROM (
      SELECT id, type, from_username, text, created_at
      FROM chat_messages
      WHERE type = 'world'
      ORDER BY id DESC
      LIMIT 20
    )
    ORDER BY id ASC
  `).all();

  res.json(rows.map(addGMFlag));
});

/* =========================
   私聊
========================= */

app.post("/api/chat/private/send", auth, (req, res) => {
  const toUsername = String(req.body.toUsername || "").trim();
  const text = cleanText(req.body.text, 80);

  if (!toUsername) {
    return res.status(400).json({ error: "请输入私聊对象" });
  }

  if (!text) {
    return res.status(400).json({ error: "聊天内容不能为空" });
  }

  if (toUsername === req.user.username) {
    return res.status(400).json({ error: "不能私聊自己" });
  }

const mute = checkMuted(req.user.id);
if (mute.muted) {
  return res.status(403).json({
    error: "你已被禁言，解禁时间：" + new Date(mute.mutedUntil).toLocaleString()
  });
}
  if (!checkChatRate(req.user.id)) {
    return res.status(429).json({ error: "发言太快，请3秒后再试" });
  }

  const target = db.prepare(`
    SELECT id, username, banned
    FROM users
    WHERE username = ?
  `).get(toUsername);

  if (!target) {
    return res.status(404).json({ error: "玩家不存在" });
  }

  const gmResult = handleGMCommand(req.user.username, text, target);

  if (gmResult.handled) {
    return res.status(gmResult.status).json(gmResult.body);
  }

  if (target.banned) {
    return res.status(403).json({ error: "该玩家已被封禁" });
  }

  const info = db.prepare(`
    INSERT INTO chat_messages (
      type, from_user_id, from_username, to_user_id, to_username, text, created_at
    )
    VALUES ('private', ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    req.user.username,
    target.id,
    target.username,
    text,
    Date.now()
  );

  trimChatTable();

  res.json({
    ok: true,
    id: info.lastInsertRowid
  });
});

app.get("/api/chat/private/list", auth, (req, res) => {
  const withUsername = String(req.query.with || "").trim();

  if (!withUsername) {
    return res.status(400).json({ error: "请输入私聊对象" });
  }

  const other = db.prepare(`
    SELECT id, username
    FROM users
    WHERE username = ?
  `).get(withUsername);

  if (!other) {
    return res.status(404).json({ error: "玩家不存在" });
  }

  const rows = db.prepare(`
    SELECT id, type, from_username, to_username, text, created_at
    FROM (
      SELECT id, type, from_username, to_username, text, created_at
      FROM chat_messages
      WHERE type = 'private'
        AND (
          (from_user_id = ? AND to_user_id = ?)
          OR
          (from_user_id = ? AND to_user_id = ?)
        )
      ORDER BY id DESC
      LIMIT 20
    )
    ORDER BY id ASC
  `).all(req.user.id, other.id, other.id, req.user.id);

  res.json(rows.map(addGMFlag));
});
app.get("/api/chat/private/inbox", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT
      id,
      type,
      from_user_id,
      from_username,
      to_user_id,
      to_username,
      text,
      created_at
    FROM (
      SELECT
        id,
        type,
        from_user_id,
        from_username,
        to_user_id,
        to_username,
        text,
        created_at
      FROM chat_messages
      WHERE type = 'private'
        AND (from_user_id = ? OR to_user_id = ?)
      ORDER BY id DESC
      LIMIT 50
    )
    ORDER BY id ASC
  `).all(req.user.id, req.user.id);
  res.json(rows.map(addGMFlag));
});

/* =========================
   帮会系统
========================= */

app.get("/api/guild/me", auth, (req, res) => {
  const guild = getMyGuild(req.user.id);

  if (!guild) {
    return res.json({
      inGuild: false,
      guild: null,
      members: []
    });
  }

  const members = db.prepare(`
    SELECT username, role, joined_at
    FROM guild_members
    WHERE guild_id = ?
    ORDER BY role DESC, joined_at ASC
  `).all(guild.guild_id);

  res.json({
    inGuild: true,
    guild,
    members
  });
});

app.get("/api/guild/list", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT
      g.id,
      g.name,
      g.leader_username,
      g.created_at,
      COUNT(gm.user_id) AS member_count
    FROM guilds g
    LEFT JOIN guild_members gm ON gm.guild_id = g.id
    GROUP BY g.id
    ORDER BY g.id DESC
    LIMIT 50
  `).all();

  res.json(rows);
});

app.post("/api/guild/create", auth, (req, res) => {
  const name = String(req.body.name || "").trim();

  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(name)) {
    return res.status(400).json({
      error: "帮会名需为2-16位中文、英文、数字或下划线"
    });
  }

  const existingMember = getMyGuild(req.user.id);

  if (existingMember) {
    return res.status(400).json({ error: "你已经加入了帮会，不能重复创建" });
  }

  const result = readUserSaveById(req.user.id);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const { user, save } = result;

  save.guildToken = Math.max(0, Math.floor(Number(save.guildToken) || 0));

  if (save.guildToken < 1) {
    return res.status(400).json({ error: "帮派令不足，无法创建帮会" });
  }

  const createGuildTx = db.transaction(() => {
    save.guildToken -= 1;

    const info = db.prepare(`
      INSERT INTO guilds (name, leader_user_id, leader_username, created_at)
      VALUES (?, ?, ?, ?)
    `).run(name, user.id, user.username, Date.now());

    db.prepare(`
      INSERT INTO guild_members (user_id, username, guild_id, role, joined_at)
      VALUES (?, ?, ?, 'leader', ?)
    `).run(user.id, user.username, info.lastInsertRowid, Date.now());

    writeUserSave(user.id, save);

    return info.lastInsertRowid;
  });

  try {
    const guildId = createGuildTx();

    res.json({
      ok: true,
      message: `帮会【${name}】创建成功`,
      guildId,
      save
    });
  } catch {
    res.status(409).json({ error: "帮会名已存在" });
  }
});

app.post("/api/guild/join", auth, (req, res) => {
  const name = String(req.body.name || "").trim();

  if (!name) {
    return res.status(400).json({ error: "请输入帮会名称" });
  }

  const existingMember = getMyGuild(req.user.id);

  if (existingMember) {
    return res.status(400).json({ error: "你已经加入了帮会" });
  }

  const guild = db.prepare(`
    SELECT id, name
    FROM guilds
    WHERE name = ?
  `).get(name);

  if (!guild) {
    return res.status(404).json({ error: "帮会不存在" });
  }

  db.prepare(`
    INSERT INTO guild_members (user_id, username, guild_id, role, joined_at)
    VALUES (?, ?, ?, 'member', ?)
  `).run(req.user.id, req.user.username, guild.id, Date.now());

  res.json({
    ok: true,
    message: `已加入帮会【${guild.name}】`
  });
});

app.post("/api/guild/leave", auth, (req, res) => {
  const guild = getMyGuild(req.user.id);

  if (!guild) {
    return res.status(400).json({ error: "你当前没有加入帮会" });
  }

  if (guild.role === "leader") {
    const memberCount = db.prepare(`
      SELECT COUNT(*) AS c
      FROM guild_members
      WHERE guild_id = ?
    `).get(guild.guild_id).c;

    if (memberCount > 1) {
      return res.status(400).json({
        error: "会长不能直接退出，请先让其他成员退出，或后续添加转让会长功能"
      });
    }

    db.prepare(`
      DELETE FROM guild_members
      WHERE guild_id = ?
    `).run(guild.guild_id);

    db.prepare(`
      DELETE FROM guilds
      WHERE id = ?
    `).run(guild.guild_id);

    db.prepare(`
      DELETE FROM chat_messages
      WHERE type = 'guild'
        AND guild_id = ?
    `).run(guild.guild_id);

    return res.json({
      ok: true,
      message: `帮会【${guild.guild_name}】已解散`
    });
  }

  db.prepare(`
    DELETE FROM guild_members
    WHERE user_id = ?
  `).run(req.user.id);

  res.json({
    ok: true,
    message: `已退出帮会【${guild.guild_name}】`
  });
});

/* =========================
   帮会聊天
========================= */

app.post("/api/chat/guild/send", auth, (req, res) => {
  const text = cleanText(req.body.text, 80);

  if (!text) {
    return res.status(400).json({ error: "聊天内容不能为空" });
  }

const mute = checkMuted(req.user.id);
if (mute.muted) {
  return res.status(403).json({
    error: "你已被禁言，解禁时间：" + new Date(mute.mutedUntil).toLocaleString()
  });
}
  if (!checkChatRate(req.user.id)) {
    return res.status(429).json({ error: "发言太快，请3秒后再试" });
  }

  const guild = getMyGuild(req.user.id);

  if (!guild) {
    return res.status(400).json({ error: "你还没有加入帮会" });
  }

  const info = db.prepare(`
    INSERT INTO chat_messages (
      type, from_user_id, from_username, guild_id, text, created_at
    )
    VALUES ('guild', ?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    req.user.username,
    guild.guild_id,
    text,
    Date.now()
  );

  db.prepare(`
    DELETE FROM chat_messages
    WHERE type = 'guild'
      AND guild_id = ?
      AND id NOT IN (
        SELECT id
        FROM chat_messages
        WHERE type = 'guild'
          AND guild_id = ?
        ORDER BY id DESC
        LIMIT 20
      )
  `).run(guild.guild_id, guild.guild_id);

  trimChatTable();

  res.json({
    ok: true,
    id: info.lastInsertRowid
  });
});

app.get("/api/chat/guild/list", auth, (req, res) => {
  const guild = getMyGuild(req.user.id);

  if (!guild) {
    return res.status(400).json({ error: "你还没有加入帮会" });
  }

  const rows = db.prepare(`
    SELECT id, type, from_username, guild_id, text, created_at
    FROM (
      SELECT id, type, from_username, guild_id, text, created_at
      FROM chat_messages
      WHERE type = 'guild'
        AND guild_id = ?
      ORDER BY id DESC
      LIMIT 20
    )
    ORDER BY id ASC
  `).all(guild.guild_id);

  res.json(rows.map(addGMFlag));
});

/* =========================
   GM 后台接口
========================= */

app.post("/api/gm/grant", gmAuth, (req, res) => {
  const username = String(req.body.username || "").trim();
  const type = String(req.body.type || "").trim();
  const amount = Math.max(1, Math.floor(Number(req.body.amount) || 0));
  const shardQuality = String(req.body.shardQuality || "").trim();

  if (!username) {
    return res.status(400).json({ error: "请输入玩家用户名" });
  }

  if (!type) {
    return res.status(400).json({ error: "请选择发放类型" });
  }

  const result = readUserSave(username);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const { user, save } = result;

  if (type === "yuanbao") {
    save.yuanbao = Math.max(0, Math.floor(Number(save.yuanbao) || 0)) + amount;
  } else if (type === "forgeStones") {
    save.forgeStones = Math.max(0, Math.floor(Number(save.forgeStones) || 0)) + amount;
  } else if (type === "vipExp") {
    save.vipExp = Math.max(0, Math.floor(Number(save.vipExp) || 0)) + amount;
  } else if (type === "doubleExpPills") {
    save.doubleExpPills = Math.max(0, Math.floor(Number(save.doubleExpPills) || 0)) + amount;
  } else if (type === "tripleExpPills") {
    save.tripleExpPills = Math.max(0, Math.floor(Number(save.tripleExpPills) || 0)) + amount;
  } else if (type === "fiveExpPills") {
    save.fiveExpPills = Math.max(0, Math.floor(Number(save.fiveExpPills) || 0)) + amount;
  } else if (type === "tenExpPills") {
    save.tenExpPills = Math.max(0, Math.floor(Number(save.tenExpPills) || 0)) + amount;
  } else if (type === "vipTrialLow") {
    save.vipTrialLow = Math.max(0, Math.floor(Number(save.vipTrialLow) || 0)) + amount;
  } else if (type === "guildToken") {
    save.guildToken = Math.max(0, Math.floor(Number(save.guildToken) || 0)) + amount;
  } else if (type === "universalShard") {
    const allowed = [
      "normal",
      "good",
      "rare",
      "epic",
      "legend",
      "myth",
      "supreme",
      "chroma",
      "god",
      "black",
      "zenlegend"
    ];

    if (!allowed.includes(shardQuality)) {
      return res.status(400).json({ error: "万能碎片品质错误" });
    }

    save.universalShards = save.universalShards || {};
    save.universalShards[shardQuality] =
      Math.max(0, Math.floor(Number(save.universalShards[shardQuality]) || 0)) + amount;
  } else {
    return res.status(400).json({ error: "不支持的发放类型" });
  }

  writeUserSave(user.id, save);

  res.json({
    ok: true,
    message: `已向 ${user.username} 发放成功`
  });
});

app.post("/api/gm/clear-ranking", gmAuth, (req, res) => {
  db.prepare(`DELETE FROM rankings`).run();

  res.json({
    ok: true,
    message: "排行榜已清空"
  });
});

app.post("/api/gm/mute", gmAuth, (req, res) => {
  const username = String(req.body.username || "").trim();
  const minutes = Math.max(1, Math.floor(Number(req.body.minutes) || 60));

  if (!username) {
    return res.status(400).json({ error: "请输入玩家用户名" });
  }

  const user = db.prepare(`
    SELECT id, username
    FROM users
    WHERE username = ?
  `).get(username);

  if (!user) {
    return res.status(404).json({ error: "玩家不存在" });
  }

  const mutedUntil = Date.now() + minutes * 60 * 1000;

  db.prepare(`
    UPDATE users
    SET muted_until = ?
    WHERE id = ?
  `).run(mutedUntil, user.id);

  res.json({
    ok: true,
    message: `${user.username} 已被禁言 ${minutes} 分钟，解禁时间：${new Date(mutedUntil).toLocaleString()}`
  });
});

app.post("/api/gm/unmute", gmAuth, (req, res) => {
  const username = String(req.body.username || "").trim();

  if (!username) {
    return res.status(400).json({ error: "请输入玩家用户名" });
  }

  const user = db.prepare(`
    SELECT id, username
    FROM users
    WHERE username = ?
  `).get(username);

  if (!user) {
    return res.status(404).json({ error: "玩家不存在" });
  }

  db.prepare(`
    UPDATE users
    SET muted_until = 0
    WHERE id = ?
  `).run(user.id);

  res.json({
    ok: true,
    message: `${user.username} 已解除禁言`
  });
});
app.post("/api/gm/ban", gmAuth, (req, res) => {
  const username = String(req.body.username || "").trim();

  if (!username) {
    return res.status(400).json({ error: "请输入玩家用户名" });
  }

  const user = db.prepare(`
    SELECT id, username
    FROM users
    WHERE username = ?
  `).get(username);

  if (!user) {
    return res.status(404).json({ error: "玩家不存在" });
  }

  db.prepare(`
    UPDATE users
    SET banned = 1
    WHERE id = ?
  `).run(user.id);

  db.prepare(`
    DELETE FROM rankings
    WHERE user_id = ?
  `).run(user.id);

  res.json({
    ok: true,
    message: `${user.username} 已被封号，并已从排行榜移除`
  });
});

app.post("/api/gm/unban", gmAuth, (req, res) => {
  const username = String(req.body.username || "").trim();

  if (!username) {
    return res.status(400).json({ error: "请输入玩家用户名" });
  }

  const user = db.prepare(`
    SELECT id, username
    FROM users
    WHERE username = ?
  `).get(username);

  if (!user) {
    return res.status(404).json({ error: "玩家不存在" });
  }

  db.prepare(`
    UPDATE users
    SET banned = 0
    WHERE id = ?
  `).run(user.id);

  res.json({
    ok: true,
    message: `${user.username} 已解除封号`
  });
});

app.post("/api/gm/clear-yuanbao", gmAuth, (req, res) => {
  const username = String(req.body.username || "").trim();

  if (!username) {
    return res.status(400).json({ error: "请输入玩家用户名" });
  }

  const result = readUserSave(username);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const { user, save } = result;

  save.yuanbao = 0;

  writeUserSave(user.id, save);

  res.json({
    ok: true,
    message: `${user.username} 的元宝已清空`
  });
});

app.post("/api/gm/clear-shards", gmAuth, (req, res) => {
  const username = String(req.body.username || "").trim();

  if (!username) {
    return res.status(400).json({ error: "请输入玩家用户名" });
  }

  const result = readUserSave(username);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const { user, save } = result;

  save.universalShards = {
    normal: 0,
    good: 0,
    rare: 0,
    epic: 0,
    legend: 0,
    myth: 0,
    supreme: 0,
    chroma: 0,
    god: 0,
    black: 0,
    zenlegend: 0
  };

  writeUserSave(user.id, save);

  res.json({
    ok: true,
    message: `${user.username} 的万能碎片已清空`
  });
});

/* =========================
   首页
========================= */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "game.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("服务器已启动，端口：" + PORT);
});