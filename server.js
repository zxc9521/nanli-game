const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const db = new Database(path.join(__dirname, "game.db"));

const JWT_SECRET = "nanli_change_this_to_a_long_random_secret_123456";
const GM_SECRET = "010212zp";

// 游戏内GM账号名单，必须和注册用户名完全一致
const GM_USERS = new Set([
  "我是南黎我是傻逼"
]);

const ARENA_SKILLS = [
  "pojun",
  "xuangui",
  "jinghua",
  "qingnang",
  "tanlang",
  "suixing",
  "shigu",
  "zhuihun",
  "tianhuo",
  "tiebi",
  "guixu",
  "tianming"
];

const ARENA_SKILL_NAMES = {
  pojun: "破军",
  xuangui: "玄龟",
  jinghua: "镜花",
  qingnang: "青囊",
  tanlang: "贪狼",
  suixing: "碎星",
  shigu: "蚀骨",
  zhuihun: "追魂",
  tianhuo: "天火",
  tiebi: "铁壁",
  guixu: "归墟",
  tianming: "天命"
};

app.use(express.json({ limit: "10mb" }));
// app.use(express.static(__dirname));

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

CREATE TABLE IF NOT EXISTS arena_players (
  user_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  power INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  vip INTEGER NOT NULL DEFAULT 0,
  skills TEXT NOT NULL DEFAULT '[]',
  rank INTEGER NOT NULL,
  arena_date TEXT NOT NULL DEFAULT '',
  arena_used INTEGER NOT NULL DEFAULT 0,
  reward_date TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS arena_battles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attacker_user_id INTEGER NOT NULL,
  defender_user_id INTEGER NOT NULL,
  attacker_username TEXT NOT NULL,
  defender_username TEXT NOT NULL,
  attacker_rank_before INTEGER NOT NULL,
  defender_rank_before INTEGER NOT NULL,
  attacker_rank_after INTEGER NOT NULL,
  defender_rank_after INTEGER NOT NULL,
  win INTEGER NOT NULL,
  log TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auction_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_user_id INTEGER NOT NULL,
  seller_username TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'equip',
  item_data TEXT NOT NULL,
  price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  buyer_user_id INTEGER,
  buyer_username TEXT,
  created_at INTEGER NOT NULL,
  expire_at INTEGER NOT NULL DEFAULT 0,
  sold_at INTEGER,
  cancelled_at INTEGER
);
CREATE TABLE IF NOT EXISTS player_resources (
  user_id INTEGER PRIMARY KEY,
  yuanbao INTEGER NOT NULL DEFAULT 0,
  copper INTEGER NOT NULL DEFAULT 0,
  forgeStones INTEGER NOT NULL DEFAULT 0,
  vipExp INTEGER NOT NULL DEFAULT 0,
  guildToken INTEGER NOT NULL DEFAULT 0,
  fateRerollStones INTEGER NOT NULL DEFAULT 0,
  beastCoins INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS beast_arena_players (
  user_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  beast_data TEXT NOT NULL,
  rank INTEGER NOT NULL,
  arena_date TEXT NOT NULL DEFAULT '',
  used INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS beast_arena_battles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attacker_user_id INTEGER NOT NULL,
  defender_user_id INTEGER NOT NULL,
  attacker_username TEXT NOT NULL,
  defender_username TEXT NOT NULL,
  attacker_rank_before INTEGER NOT NULL,
  defender_rank_before INTEGER NOT NULL,
  attacker_rank_after INTEGER NOT NULL,
  defender_rank_after INTEGER NOT NULL,
  win INTEGER NOT NULL,
  coin_reward INTEGER NOT NULL DEFAULT 0,
  log TEXT NOT NULL,
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
const auctionColumns = db.prepare(`PRAGMA table_info(auction_listings)`).all().map(col => col.name);

if (!auctionColumns.includes("item_type")) {
  db.exec(`ALTER TABLE auction_listings ADD COLUMN item_type TEXT NOT NULL DEFAULT 'equip'`);
}

if (!auctionColumns.includes("expire_at")) {
  db.exec(`ALTER TABLE auction_listings ADD COLUMN expire_at INTEGER NOT NULL DEFAULT 0`);
}
db.prepare(`
  UPDATE auction_listings
  SET expire_at = created_at + ?
  WHERE status = 'active'
    AND expire_at = 0
`).run(24 * 60 * 60 * 1000);

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
  return GM_USERS.has(String(username || ""));
}

function getUserTitle(username) {
  username = String(username || "");

  if (!username) return "";

  const titles = [];

  const powerRows = db.prepare(`
    SELECT username
    FROM rankings
    ORDER BY power DESC, level DESC, vip DESC
    LIMIT 3
  `).all();

  const powerIndex = powerRows.findIndex(r => r.username === username);

  if (powerIndex === 0) titles.push("战力榜第一");
  if (powerIndex === 1) titles.push("战力榜第二");
  if (powerIndex === 2) titles.push("战力榜第三");

  const arenaRow = db.prepare(`
    SELECT rank
    FROM arena_players
    WHERE username = ?
  `).get(username);

  if (arenaRow) {
    if (arenaRow.rank === 1) titles.push("竞技场第一");
    if (arenaRow.rank === 2) titles.push("竞技场第二");
    if (arenaRow.rank === 3) titles.push("竞技场第三");
  }

  return titles.join(" · ");
}

function addGMFlag(row) {
  return {
    ...row,
    from_is_gm: isGameGM(row.from_username) ? 1 : 0,
    to_is_gm: isGameGM(row.to_username) ? 1 : 0,
    from_title: getUserTitle(row.from_username),
    to_title: getUserTitle(row.to_username)
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
    /^JY\s+\d+$/i.test(content) ||
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

    db.prepare(`
      DELETE FROM arena_players
      WHERE user_id = ?
    `).run(target.id);

    addAnnouncement(`玩家 ${target.username} 已被GM ${username} 封禁`);

    return gmCommandOk(`${target.username} 已被封禁，并已从排行榜和竞技场移除`);
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
  const now = Date.now();

  save = save && typeof save === "object" ? save : {};

  const resources = ensurePlayerResources(userId, save);
  applyResourcesToSave(save, resources);

  save.last = now;
  save.cloudUpdatedAt = now;

  db.prepare(`
    UPDATE users
    SET save_data = ?, save_updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(save), now, userId);

  return now;
}
const RESOURCE_KEYS = [
  "yuanbao",
  "copper",
  "forgeStones",
  "vipExp",
  "guildToken",
  "fateRerollStones",
  "beastCoins"
];

function num(v) {
  return Math.max(0, Math.floor(Number(v) || 0));
}

function defaultResourcesFromSave(save = {}) {
  return {
    yuanbao: num(save.yuanbao),
    copper: num(save.copper),
    forgeStones: num(save.forgeStones),
    vipExp: num(save.vipExp),
    guildToken: num(save.guildToken),
    fateRerollStones: num(save.fateRerollStones),
    beastCoins: num(save.beastCoins),
  };
}

function ensurePlayerResources(userId, saveForInit = {}) {
  let row = db.prepare(`
    SELECT *
    FROM player_resources
    WHERE user_id = ?
  `).get(userId);

  if (row) return row;

  const r = defaultResourcesFromSave(saveForInit);

  db.prepare(`
    INSERT INTO player_resources (
      user_id,
      yuanbao,
      copper,
      forgeStones,
      vipExp,
      guildToken,
      fateRerollStones,
      beastCoins,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    r.yuanbao,
    r.copper,
    r.forgeStones,
    r.vipExp,
    r.guildToken,
    r.fateRerollStones,
    r.beastCoins,
    Date.now()
  );

  row = db.prepare(`
    SELECT *
    FROM player_resources
    WHERE user_id = ?
  `).get(userId);

  return row;
}

function getPlayerResources(userId, saveForInit = {}) {
  return ensurePlayerResources(userId, saveForInit);
}

function applyResourcesToSave(save, resources) {
  save = save && typeof save === "object" ? save : {};

  save.yuanbao = num(resources.yuanbao);
  save.copper = num(resources.copper);
  save.forgeStones = num(resources.forgeStones);
  save.vipExp = num(resources.vipExp);
  save.guildToken = num(resources.guildToken);
  save.fateRerollStones = num(resources.fateRerollStones);
  save.beastCoins = num(resources.beastCoins);

  return save;
}

function addPlayerResource(userId, key, amount) {
  if (!RESOURCE_KEYS.includes(key)) {
    throw new Error("资源类型错误：" + key);
  }

  amount = Math.floor(Number(amount) || 0);

  const row = ensurePlayerResources(userId);

  const next = Math.max(0, num(row[key]) + amount);

  db.prepare(`
    UPDATE player_resources
    SET ${key} = ?,
        updated_at = ?
    WHERE user_id = ?
  `).run(next, Date.now(), userId);

  return next;
}

function setPlayerResource(userId, key, value) {
  if (!RESOURCE_KEYS.includes(key)) {
    throw new Error("资源类型错误：" + key);
  }

  value = num(value);

  ensurePlayerResources(userId);

  db.prepare(`
    UPDATE player_resources
    SET ${key} = ?,
        updated_at = ?
    WHERE user_id = ?
  `).run(value, Date.now(), userId);

  return value;
}

function spendPlayerResource(userId, key, amount) {
  if (!RESOURCE_KEYS.includes(key)) {
    throw new Error("资源类型错误：" + key);
  }

  amount = Math.max(1, Math.floor(Number(amount) || 0));

  const row = ensurePlayerResources(userId);

  if (num(row[key]) < amount) {
    return false;
  }

  db.prepare(`
    UPDATE player_resources
    SET ${key} = ${key} - ?,
        updated_at = ?
    WHERE user_id = ?
  `).run(amount, Date.now(), userId);

  return true;
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
   竞技场工具函数
========================= */

function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}

function parseSkills(text) {
  try {
    const arr = JSON.parse(text || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function normalizeArenaSkills(skills) {
  if (!Array.isArray(skills)) return null;

  const clean = [];

  for (const id of skills) {
    const s = String(id || "").trim();

    if (!ARENA_SKILLS.includes(s)) {
      return null;
    }

    if (!clean.includes(s)) {
      clean.push(s);
    }
  }

  if (clean.length !== 4) {
    return null;
  }

  return clean;
}

function getNextArenaRank() {
  const row = db.prepare(`
    SELECT MAX(rank) AS m
    FROM arena_players
  `).get();

  return Math.max(1, Number(row?.m || 0) + 1);
}

function getArenaPlayer(userId) {
  return db.prepare(`
    SELECT *
    FROM arena_players
    WHERE user_id = ?
  `).get(userId);
}

function getArenaNearbyRows(me) {
  if (!me) return [];

  if (me.rank <= 1) {
    return db.prepare(`
      SELECT user_id, username, power, level, vip, skills, rank, updated_at
      FROM arena_players
      WHERE rank > ?
      ORDER BY rank ASC
      LIMIT 5
    `).all(me.rank);
  }

  const start = Math.max(1, me.rank - 5);

  return db.prepare(`
    SELECT user_id, username, power, level, vip, skills, rank, updated_at
    FROM arena_players
    WHERE rank >= ?
      AND rank < ?
    ORDER BY rank ASC
    LIMIT 5
  `).all(start, me.rank);
}

function arenaSkillScore(skills, enemySkills) {
  const has = id => skills.includes(id);
  const enemyHas = id => enemySkills.includes(id);

  let score = 0;

  for (const id of skills) {
    if (id === "pojun") score += 13;
    if (id === "xuangui") score += 12;
    if (id === "jinghua") score += 12;
    if (id === "qingnang") score += 11;
    if (id === "tanlang") score += 12;
    if (id === "suixing") score += 12;
    if (id === "shigu") score += 10;
    if (id === "zhuihun") score += 13;
    if (id === "tianhuo") score += 11;
    if (id === "tiebi") score += 11;
    if (id === "guixu") score += 12;
    if (id === "tianming") score += Math.floor(8 + Math.random() * 12);
  }

  if (has("pojun") && has("zhuihun")) score += 10;
  if (has("xuangui") && has("jinghua")) score += 9;
  if (has("qingnang") && has("guixu")) score += 9;
  if (has("tanlang") && has("tianhuo")) score += 7;
  if (has("suixing") && has("shigu")) score += 7;
  if (has("tiebi") && has("xuangui")) score += 6;
  if (has("tianming")) score += Math.floor(Math.random() * 18) - 6;

  if (has("pojun") && (enemyHas("xuangui") || enemyHas("qingnang") || enemyHas("guixu"))) score += 8;
  if (has("xuangui") && (enemyHas("pojun") || enemyHas("zhuihun") || enemyHas("tianhuo"))) score += 8;
  if (has("jinghua") && (enemyHas("pojun") || enemyHas("zhuihun") || enemyHas("tianhuo"))) score += 9;
  if (has("qingnang") && (enemyHas("shigu") || enemyHas("tianhuo") || enemyHas("guixu"))) score += 7;
  if (has("tanlang") && (enemyHas("qingnang") || enemyHas("xuangui") || enemyHas("guixu"))) score += 9;
  if (has("suixing") && (enemyHas("xuangui") || enemyHas("tiebi") || enemyHas("qingnang"))) score += 9;
  if (has("shigu") && (enemyHas("jinghua") || enemyHas("qingnang") || enemyHas("xuangui"))) score += 8;
  if (has("zhuihun") && (enemyHas("shigu") || enemyHas("guixu") || enemyHas("qingnang"))) score += 8;
  if (has("tianhuo") && (enemyHas("shigu") || enemyHas("guixu") || enemyHas("tanlang"))) score += 7;
  if (has("tiebi") && (enemyHas("zhuihun") || enemyHas("tianhuo") || enemyHas("shigu"))) score += 8;
  if (has("guixu") && (enemyHas("tiebi") || enemyHas("xuangui") || enemyHas("qingnang"))) score += 7;

  if (has("pojun") && (enemyHas("jinghua") || enemyHas("tiebi"))) score -= 8;
  if (has("xuangui") && (enemyHas("suixing") || enemyHas("tanlang"))) score -= 8;
  if (has("qingnang") && enemyHas("tanlang")) score -= 10;
  if (has("guixu") && (enemyHas("zhuihun") || enemyHas("pojun") || enemyHas("tanlang"))) score -= 8;

  return score;
}

function skillNames(skills) {
  return skills.map(id => ARENA_SKILL_NAMES[id] || id).join("、");
}

function simulateArenaBattle(attacker, defender) {
  const aSkills = parseSkills(attacker.skills);
  const dSkills = parseSkills(defender.skills);

  const aScore = arenaSkillScore(aSkills, dSkills);
  const dScore = arenaSkillScore(dSkills, aSkills);

  // 竞技场不看战力、不看等级、不看VIP
  // 所有人基础属性完全一样
  const aBase = 100000;
  const dBase = 100000;

  const aRoll = 0.88 + Math.random() * 0.24;
  const dRoll = 0.88 + Math.random() * 0.24;

  const aFinal = Math.floor(aBase * (1 + aScore / 100) * aRoll);
  const dFinal = Math.floor(dBase * (1 + dScore / 100) * dRoll);

  const win = aFinal >= dFinal;

  const log = [];

  log.push(`【竞技场第一赛季】${attacker.username} 向 ${defender.username} 发起挑战。`);
  log.push(`挑战方技能：${skillNames(aSkills)}。`);
  log.push(`防守方技能：${skillNames(dSkills)}。`);

  if (aSkills.includes("pojun")) log.push(`${attacker.username} 携【破军】开局压阵，试图三回合内打穿对手。`);
  if (aSkills.includes("xuangui")) log.push(`${attacker.username} 祭出【玄龟】，厚重护盾覆盖全身。`);
  if (aSkills.includes("jinghua")) log.push(`${attacker.username} 布下【镜花】，等待敌方爆发反噬。`);
  if (aSkills.includes("qingnang")) log.push(`${attacker.username} 运转【青囊】，准备以续航拖垮对手。`);
  if (aSkills.includes("tanlang")) log.push(`${attacker.username} 唤醒【贪狼】，吸血与禁疗同时压迫。`);
  if (aSkills.includes("suixing")) log.push(`${attacker.username} 引动【碎星】，真实伤害开始撕裂防御。`);
  if (aSkills.includes("shigu")) log.push(`${attacker.username} 释放【蚀骨】，毒层逐渐腐蚀对手根基。`);
  if (aSkills.includes("zhuihun")) log.push(`${attacker.username} 发动【追魂】，抢占先手寻找斩杀机会。`);
  if (aSkills.includes("tianhuo")) log.push(`${attacker.username} 召来【天火】，灼烧与引燃不断施压。`);
  if (aSkills.includes("tiebi")) log.push(`${attacker.username} 立起【铁壁】，连续伤害被层层削弱。`);
  if (aSkills.includes("guixu")) log.push(`${attacker.username} 沉入【归墟】，越拖到后期越危险。`);
  if (aSkills.includes("tianming")) log.push(`${attacker.username} 选择【天命】，本局胜负多了几分赌性。`);

  log.push(`挑战方竞技评分：${aFinal.toLocaleString()}。`);
  log.push(`防守方竞技评分：${dFinal.toLocaleString()}。`);

  if (win) {
    log.push(`战斗结果：${attacker.username} 胜利。`);
  } else {
    log.push(`战斗结果：${defender.username} 防守成功。`);
  }

  return {
    win,
    attackerScore: aFinal,
    defenderScore: dFinal,
    log
  };
}

function arenaRewardByRank(rank) {
  rank = Math.max(1, Math.floor(Number(rank) || 999999));

  if (rank === 1) {
    return { yb: 10000, forge: 30000, fate: 2, black: 2, god: 1, rare: 0, legend: 0 };
  }

  if (rank === 2) {
    return { yb: 7000, forge: 22000, fate: 2, black: 2, god: 0, rare: 0, legend: 0 };
  }

  if (rank === 3) {
    return { yb: 5000, forge: 16000, fate: 1, black: 1, god: 0, rare: 0, legend: 0 };
  }

  if (rank <= 10) {
    return { yb: 3000, forge: 10000, fate: 1, black: 0, god: 0, rare: 0, legend: 3 };
  }

  if (rank <= 50) {
    return { yb: 1500, forge: 5000, fate: 0, black: 0, god: 0, rare: 5, legend: 0 };
  }

  return { yb: 300, forge: 1000, fate: 0, black: 0, god: 0, rare: 0, legend: 0 };
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
    ensurePlayerResources(req.user.id, {});

    return res.json({
      save: null,
      updatedAt: 0
    });
  }

  try {
    const save = JSON.parse(user.save_data);

    const resources = ensurePlayerResources(req.user.id, save);
    applyResourcesToSave(save, resources);

    save.cloudUpdatedAt = user.save_updated_at || 0;

    res.json({
      save,
      updatedAt: user.save_updated_at || 0
    });
    } catch {
    ensurePlayerResources(req.user.id, {});

    res.json({
      save: null,
      updatedAt: 0
    });
  }
});
app.post("/api/save", auth, (req, res) => {
  const save = req.body.save;

  if (!save || typeof save !== "object" || Array.isArray(save)) {
    return res.status(400).json({ error: "存档格式错误" });
  }

  const current = db.prepare(`
    SELECT save_updated_at
    FROM users
    WHERE id = ?
  `).get(req.user.id);

  const serverUpdatedAt = Math.max(0, Math.floor(Number(current?.save_updated_at) || 0));
  const clientBaseUpdatedAt = Math.max(0, Math.floor(Number(req.body.baseUpdatedAt ?? save.cloudUpdatedAt) || 0));

  if (serverUpdatedAt > 0 && clientBaseUpdatedAt < serverUpdatedAt) {
    return res.status(409).json({
      error: "云端存档比当前本地存档更新。为避免旧存档覆盖新存档，请先读取云端存档。",
      serverUpdatedAt,
      clientBaseUpdatedAt
    });
  }

  const oldResources = ensurePlayerResources(req.user.id, save);

  const mergedResources = {
    yuanbao: Math.max(num(oldResources.yuanbao), num(save.yuanbao)),
    copper: Math.max(num(oldResources.copper), num(save.copper)),
    forgeStones: Math.max(num(oldResources.forgeStones), num(save.forgeStones)),
    vipExp: Math.max(num(oldResources.vipExp), num(save.vipExp)),
    guildToken: Math.max(num(oldResources.guildToken), num(save.guildToken)),
    fateRerollStones: Math.max(num(oldResources.fateRerollStones), num(save.fateRerollStones)),
    beastCoins: Math.max(num(oldResources.beastCoins), num(save.beastCoins))
  };

  db.prepare(`
    UPDATE player_resources
    SET yuanbao = ?,
        copper = ?,
        forgeStones = ?,
        vipExp = ?,
        guildToken = ?,
        fateRerollStones = ?,
        beastCoins = ?,
        updated_at = ?
    WHERE user_id = ?
  `).run(
    mergedResources.yuanbao,
    mergedResources.copper,
    mergedResources.forgeStones,
    mergedResources.vipExp,
    mergedResources.guildToken,
    mergedResources.fateRerollStones,
    mergedResources.beastCoins,
    Date.now(),
    req.user.id
  );

  applyResourcesToSave(save, mergedResources);

  const saveTextCheck = JSON.stringify(save);

  if (saveTextCheck.length > 8 * 1024 * 1024) {
    return res.status(400).json({ error: "存档太大，请先清理背包" });
  }

  const now = Date.now();

  save.last = now;
  save.cloudUpdatedAt = now;

  const saveText = JSON.stringify(save);

  db.prepare(`
    UPDATE users
    SET save_data = ?, save_updated_at = ?
    WHERE id = ?
  `).run(saveText, now, req.user.id);

  res.json({
    ok: true,
    updatedAt: now,
    save
  });
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

  db.prepare(`
  UPDATE arena_players
  SET level = ?, vip = ?, updated_at = ?
  WHERE user_id = ?
`).run(level, vip, Date.now(), req.user.id);

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
   竞技场第一赛季
========================= */

app.post("/api/arena/config", auth, (req, res) => {
  const skills = normalizeArenaSkills(req.body.skills);

  if (!skills) {
    return res.status(400).json({ error: "竞技场技能配置错误，必须选择4个不同技能" });
  }

  const ranking = db.prepare(`
    SELECT power, level, vip
    FROM rankings
    WHERE user_id = ?
  `).get(req.user.id);

  const power = 0;
  const level = Math.max(1, Math.floor(Number(req.body.level ?? ranking?.level) || 1));
  const vip = Math.max(0, Math.floor(Number(req.body.vip ?? ranking?.vip) || 0));

  const existing = getArenaPlayer(req.user.id);
  const rank = existing ? existing.rank : getNextArenaRank();

  db.prepare(`
    INSERT INTO arena_players (
      user_id, username, power, level, vip, skills, rank, arena_date, arena_used, reward_date, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, '', ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      power = excluded.power,
      level = excluded.level,
      vip = excluded.vip,
      skills = excluded.skills,
      updated_at = excluded.updated_at
  `).run(
    req.user.id,
    req.user.username,
    power,
    level,
    vip,
    JSON.stringify(skills),
    rank,
    Date.now()
  );

  const me = getArenaPlayer(req.user.id);

  res.json({
    ok: true,
    message: "竞技场技能配置已保存",
    me: {
      username: me.username,
      rank: me.rank,
      level: me.level,
      vip: me.vip,
      skills: parseSkills(me.skills),
      arenaUsed: me.arena_used,
      arenaLimit: 10,
      rewardDate: me.reward_date
    }
  });
});

app.get("/api/arena/me", auth, (req, res) => {
  const me = getArenaPlayer(req.user.id);

  if (!me) {
    return res.json({
      joined: false,
      message: "尚未配置竞技场技能"
    });
  }

  const d = todayKey();
  let arenaUsed = me.arena_used;

  if (me.arena_date !== d) {
    arenaUsed = 0;
  }

  res.json({
    joined: true,
    username: me.username,
    rank: me.rank,
    level: me.level,
    vip: me.vip,
    skills: parseSkills(me.skills),
    arenaUsed,
    arenaLimit: 10,
    rewardClaimed: me.reward_date === d
  });
});

app.get("/api/arena/nearby", auth, (req, res) => {
  const me = getArenaPlayer(req.user.id);

  if (!me) {
    return res.status(400).json({ error: "请先配置竞技场技能" });
  }

  const rows = getArenaNearbyRows(me).map(r => ({
    userId: r.user_id,
    username: r.username,
    rank: r.rank,
    level: r.level,
    vip: r.vip,
    skills: parseSkills(r.skills),
    updatedAt: r.updated_at
  }));

  res.json({
    me: {
      username: me.username,
      rank: me.rank,
      level: me.level,
      vip: me.vip,
      skills: parseSkills(me.skills)
    },
    rows
  });
});

app.post("/api/arena/challenge", auth, (req, res) => {
  const targetUserId = Math.max(1, Math.floor(Number(req.body.targetUserId) || 0));

  if (!targetUserId) {
    return res.status(400).json({ error: "挑战目标错误" });
  }

  if (targetUserId === req.user.id) {
    return res.status(400).json({ error: "不能挑战自己" });
  }

  const d = todayKey();
  let resultPayload = null;

  const tx = db.transaction(() => {
    const attacker = getArenaPlayer(req.user.id);

    if (!attacker) {
      throw new Error("请先配置竞技场技能");
    }

if (attacker.arena_date !== d) {
  db.prepare(`
    UPDATE arena_players
    SET arena_date = ?, arena_used = 0
    WHERE user_id = ?
  `).run(d, req.user.id);
  attacker.arena_date = d;
  attacker.arena_used = 0;
}

    if (attacker.arena_used >= 10) {
      throw new Error("今日竞技场挑战次数已用完");
    }

    const defender = getArenaPlayer(targetUserId);

    if (!defender) {
      throw new Error("目标玩家尚未进入竞技场");
    }

    const nearby = getArenaNearbyRows(attacker).map(r => r.user_id);

    if (!nearby.includes(targetUserId)) {
      throw new Error("只能挑战排名附近五名玩家");
    }

    const sim = simulateArenaBattle(attacker, defender);

    const attackerRankBefore = attacker.rank;
    const defenderRankBefore = defender.rank;

    let attackerRankAfter = attackerRankBefore;
    let defenderRankAfter = defenderRankBefore;

    if (sim.win && defender.rank < attacker.rank) {
      attackerRankAfter = defender.rank;
      defenderRankAfter = attacker.rank;

      db.prepare(`
        UPDATE arena_players
        SET rank = ?
        WHERE user_id = ?
      `).run(attackerRankAfter, attacker.user_id);

      db.prepare(`
        UPDATE arena_players
        SET rank = ?
        WHERE user_id = ?
      `).run(defenderRankAfter, defender.user_id);
    }

    db.prepare(`
      UPDATE arena_players
      SET arena_used = arena_used + 1, arena_date = ?
      WHERE user_id = ?
    `).run(d, attacker.user_id);

    const info = db.prepare(`
      INSERT INTO arena_battles (
        attacker_user_id,
        defender_user_id,
        attacker_username,
        defender_username,
        attacker_rank_before,
        defender_rank_before,
        attacker_rank_after,
        defender_rank_after,
        win,
        log,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attacker.user_id,
      defender.user_id,
      attacker.username,
      defender.username,
      attackerRankBefore,
      defenderRankBefore,
      attackerRankAfter,
      defenderRankAfter,
      sim.win ? 1 : 0,
      JSON.stringify(sim.log),
      Date.now()
    );

    resultPayload = {
      ok: true,
      battleId: info.lastInsertRowid,
      win: sim.win,
      log: sim.log,
      attackerRankBefore,
      defenderRankBefore,
      attackerRankAfter,
      defenderRankAfter,
      arenaUsed: attacker.arena_used + 1,
      arenaLimit: 10
    };
  });

  try {
    tx();
    res.json(resultPayload);
  } catch (err) {
    res.status(400).json({ error: err.message || "挑战失败" });
  }
});

app.get("/api/arena/battles", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT *
    FROM arena_battles
    WHERE attacker_user_id = ?
       OR defender_user_id = ?
    ORDER BY id DESC
    LIMIT 20
  `).all(req.user.id, req.user.id);

  res.json(rows.map(r => ({
    id: r.id,
    attackerUsername: r.attacker_username,
    defenderUsername: r.defender_username,
    win: !!r.win,
    log: (() => {
      try {
        return JSON.parse(r.log);
      } catch {
        return [];
      }
    })(),
    createdAt: r.created_at,
    attackerRankBefore: r.attacker_rank_before,
    defenderRankBefore: r.defender_rank_before,
    attackerRankAfter: r.attacker_rank_after,
    defenderRankAfter: r.defender_rank_after
  })));
});

app.post("/api/arena/reward", auth, (req, res) => {
  const me = getArenaPlayer(req.user.id);

  if (!me) {
    return res.status(400).json({ error: "请先进入竞技场" });
  }

  const d = todayKey();

  if (me.reward_date === d) {
    return res.status(400).json({ error: "今日竞技场奖励已经领取过" });
  }

  const result = readUserSaveById(req.user.id);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const { save } = result;
  const reward = arenaRewardByRank(me.rank);

  addPlayerResource(req.user.id, "yuanbao", reward.yb);
addPlayerResource(req.user.id, "forgeStones", reward.forge);
addPlayerResource(req.user.id, "fateRerollStones", reward.fate);

  save.universalShards = save.universalShards || {};
  save.universalShards.black = Math.max(0, Math.floor(Number(save.universalShards.black) || 0)) + reward.black;
  save.universalShards.god = Math.max(0, Math.floor(Number(save.universalShards.god) || 0)) + reward.god;
  save.universalShards.rare = Math.max(0, Math.floor(Number(save.universalShards.rare) || 0)) + reward.rare;
  save.universalShards.legend = Math.max(0, Math.floor(Number(save.universalShards.legend) || 0)) + reward.legend;

  writeUserSave(req.user.id, save);

  db.prepare(`
    UPDATE arena_players
    SET reward_date = ?
    WHERE user_id = ?
  `).run(d, req.user.id);

  res.json({
    ok: true,
    message: `领取竞技场第${me.rank}名每日奖励成功`,
    rank: me.rank,
    reward,
    save
  });
});

/* =========================
   全服通报
========================= */

app.post("/api/announcement", auth, (req, res) => {
  const text = cleanText(req.body.text, 120);

  if (!text) {
    return res.status(400).json({ error: "通报内容错误" });
  }

  addAnnouncement(text);

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

  const mute = checkMuted(req.user.id);

  if (mute.muted) {
    return res.status(403).json({
      error: "你已被禁言，解禁时间：" + new Date(mute.mutedUntil).toLocaleString()
    });
  }

  if (!checkChatRate(req.user.id)) {
    return res.status(429).json({ error: "发言太快，请3秒后再试" });
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

  const resources = getPlayerResources(req.user.id, save);

if (num(resources.guildToken) < 1) {
  return res.status(400).json({ error: "帮派令不足，无法创建帮会" });
}

  const createGuildTx = db.transaction(() => {
    db.prepare(`
      UPDATE player_resources
      SET guildToken = guildToken - 1,
          updated_at = ?
      WHERE user_id = ?
    `).run(Date.now(), user.id);

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
   全服斗兽排行
========================= */

function parseBeastData(text) {
  try {
    const b = JSON.parse(text || "{}");
    return b && typeof b === "object" ? b : null;
  } catch {
    return null;
  }
}

function getNextBeastArenaRank() {
  const row = db.prepare(`
    SELECT MAX(rank) AS m
    FROM beast_arena_players
  `).get();

  return Math.max(1, Number(row?.m || 0) + 1);
}

function getBeastArenaPlayer(userId) {
  return db.prepare(`
    SELECT *
    FROM beast_arena_players
    WHERE user_id = ?
  `).get(userId);
}

function getBeastArenaNearbyRows(me) {
  if (!me) return [];

  if (me.rank <= 1) {
    return db.prepare(`
      SELECT user_id, username, beast_data, rank, updated_at
      FROM beast_arena_players
      WHERE rank > ?
      ORDER BY rank ASC
      LIMIT 5
    `).all(me.rank);
  }

  const start = Math.max(1, me.rank - 5);

  return db.prepare(`
    SELECT user_id, username, beast_data, rank, updated_at
    FROM beast_arena_players
    WHERE rank >= ?
      AND rank < ?
    ORDER BY rank ASC
    LIMIT 5
  `).all(start, me.rank);
}

function beastQualityServerName(q) {
  const names = [
    "普通",
    "优秀",
    "精良",
    "卓越",
    "传说",
    "神话",
    "至臻",
    "炫彩",
    "神",
    "黑",
    "臻彩传奇"
  ];

  return names[Math.max(0, Math.min(names.length - 1, Math.floor(Number(q) || 0)))] || "普通";
}

function beastAffinityServerMult(beast) {
  const a = Math.max(0, Math.min(100, Math.floor(Number(beast?.affinity) || 0)));

  if (a >= 80) return 1.2;

  return 0.6 + a / 80 * 0.6;
}

function beastServerStats(beast) {
  const level = Math.max(1, Math.floor(Number(beast.level) || 1));
  const q = Math.max(0, Math.floor(Number(beast.q) || 0));
  const aptitude = Math.max(1, Math.floor(Number(beast.aptitude) || 1));
  const affinity = beastAffinityServerMult(beast);
  const evolve = 1 + Math.max(0, Math.floor(Number(beast.evolve) || 0)) * 0.08;

  const qMult = 1 + q * 0.16;
  const aptMult = 0.7 + aptitude / 100 * 0.8;
  const type = beast.type || "support";

  let hp = 100 + level * 18;
  let atk = 18 + level * 4;
  let def = 8 + level * 2.4;
  let spd = 10 + level * 1.8;
  let crit = 0.05 + q * 0.006 + aptitude * 0.0008;

  if (type === "battle") {
    hp *= 1.08;
    atk *= 1.22;
    def *= 1.05;
    spd *= 1.05;
    crit += 0.03;
  } else {
    hp *= 1.18;
    atk *= 0.9;
    def *= 1.16;
    spd *= 1.08;
  }

  return {
    hp: Math.floor(hp * qMult * aptMult * affinity * evolve),
    atk: Math.floor(atk * qMult * aptMult * affinity * evolve),
    def: Math.floor(def * qMult * aptMult * affinity * evolve),
    spd: Math.floor(spd * qMult * aptMult * affinity * evolve),
    crit: Math.min(0.45, crit * affinity)
  };
}

function simulateServerBeastBattle(attackerBeast, defenderBeast) {
  const a = JSON.parse(JSON.stringify(attackerBeast));
  const b = JSON.parse(JSON.stringify(defenderBeast));

  const aStats = beastServerStats(a);
  const bStats = beastServerStats(b);

  let ahp = aStats.hp;
  let bhp = bStats.hp;

  const log = [];

  log.push(`【全服斗兽排行】${a.name} 挑战 ${b.name}`);
  log.push(`挑战方：【${beastQualityServerName(a.q)}】${a.name} Lv.${a.level}，资质 ${a.aptitude || 0}，好感 ${a.affinity || 0}`);
  log.push(`防守方：【${beastQualityServerName(b.q)}】${b.name} Lv.${b.level}，资质 ${b.aptitude || 0}，好感 ${b.affinity || 0}`);
  log.push(`挑战方属性：生命${aStats.hp}，攻击${aStats.atk}，防御${aStats.def}，速度${aStats.spd}，暴击${(aStats.crit * 100).toFixed(1)}%`);
  log.push(`防守方属性：生命${bStats.hp}，攻击${bStats.atk}，防御${bStats.def}，速度${bStats.spd}，暴击${(bStats.crit * 100).toFixed(1)}%`);

  const first = aStats.spd >= bStats.spd ? "a" : "b";

  function doAttack(attacker, defender, atkStats, defStats, attackerName, defenderName, round) {
    let dmg = Math.max(1, Math.floor(atkStats.atk * (0.85 + Math.random() * 0.3) - defStats.def * 0.45));
    let crit = false;

    if (Math.random() < atkStats.crit) {
      crit = true;
      dmg = Math.floor(dmg * 1.65);
    }

    if (round % 4 === 0) {
      dmg = Math.floor(dmg * 1.25);
      log.push(`${attackerName} 释放主动技能【${attacker.activeSkill || "灵兽猛击"}】！`);
    }

    if (attacker.type === "battle" && Math.random() < 0.18) {
      dmg = Math.floor(dmg * 1.18);
      log.push(`${attackerName} 的被动【${attacker.passiveSkill || "战斗本能"}】触发，伤害提高。`);
    }

    log.push(`${attackerName} 攻击 ${defenderName}，造成 ${dmg}${crit ? " 暴击" : ""}伤害。`);

    return dmg;
  }

  for (let round = 1; round <= 30; round++) {
    log.push(`第${round}回合：`);

    if (first === "a") {
      bhp -= doAttack(a, b, aStats, bStats, "挑战方", "防守方", round);

      if (bhp <= 0) {
        log.push(`防守方 ${b.name} 倒下。`);
        break;
      }

      ahp -= doAttack(b, a, bStats, aStats, "防守方", "挑战方", round);

      if (ahp <= 0) {
        log.push(`挑战方 ${a.name} 倒下。`);
        break;
      }
    } else {
      ahp -= doAttack(b, a, bStats, aStats, "防守方", "挑战方", round);

      if (ahp <= 0) {
        log.push(`挑战方 ${a.name} 倒下。`);
        break;
      }

      bhp -= doAttack(a, b, aStats, bStats, "挑战方", "防守方", round);

      if (bhp <= 0) {
        log.push(`防守方 ${b.name} 倒下。`);
        break;
      }
    }

    if (a.type === "support" && Math.random() < 0.12) {
      const heal = Math.floor(aStats.hp * 0.04);
      ahp = Math.min(aStats.hp, ahp + heal);
      log.push(`挑战方辅助被动触发，恢复 ${heal} 生命。`);
    }

    if (b.type === "support" && Math.random() < 0.12) {
      const heal = Math.floor(bStats.hp * 0.04);
      bhp = Math.min(bStats.hp, bhp + heal);
      log.push(`防守方辅助被动触发，恢复 ${heal} 生命。`);
    }

    log.push(`回合结束：挑战方生命 ${Math.max(0, ahp)}/${aStats.hp}，防守方生命 ${Math.max(0, bhp)}/${bStats.hp}`);
  }

  let win = false;

  if (ahp > 0 && bhp <= 0) win = true;
  else if (ahp > 0 && bhp > 0) win = ahp >= bhp;

  log.push(win ? "战斗结果：挑战方胜利！" : "战斗结果：防守方获胜。");

  return {
    win,
    log
  };
}

function beastCoinRewardByRank(rank, win) {
  if (!win) return 5;

  if (rank <= 3) return 120;
  if (rank <= 10) return 90;
  if (rank <= 50) return 60;
  return 40;
}

app.post("/api/beast-arena/config", auth, (req, res) => {
  const beastId = String(req.body.beastId || "").trim();

  if (!beastId) {
    return res.status(400).json({ error: "请选择灵兽" });
  }

  const result = readUserSaveById(req.user.id);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const { save } = result;

  save.spiritBeasts = Array.isArray(save.spiritBeasts) ? save.spiritBeasts : [];

  const beast = save.spiritBeasts.find(b => b && b.id === beastId);

  if (!beast) {
    return res.status(400).json({ error: "云存档中没有找到该灵兽，请先保存存档" });
  }

  if (!beast.appraised) {
    return res.status(400).json({ error: "该灵兽还没有鉴定资质，无法配置斗兽排行" });
  }

  const existing = getBeastArenaPlayer(req.user.id);
  const rank = existing ? existing.rank : getNextBeastArenaRank();

  db.prepare(`
    INSERT INTO beast_arena_players (
      user_id,
      username,
      beast_data,
      rank,
      arena_date,
      used,
      updated_at
    )
    VALUES (?, ?, ?, ?, '', 0, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      beast_data = excluded.beast_data,
      updated_at = excluded.updated_at
  `).run(
    req.user.id,
    req.user.username,
    JSON.stringify(beast),
    rank,
    Date.now()
  );

  const me = getBeastArenaPlayer(req.user.id);

  res.json({
    ok: true,
    message: "斗兽排行防守灵兽已配置",
    me: {
      username: me.username,
      rank: me.rank,
      beast: parseBeastData(me.beast_data)
    }
  });
});

app.get("/api/beast-arena/me", auth, (req, res) => {
  const me = getBeastArenaPlayer(req.user.id);

  if (!me) {
    return res.json({
      joined: false,
      message: "尚未配置斗兽排行灵兽"
    });
  }

  const d = todayKey();
  const used = me.arena_date === d ? me.used : 0;

  res.json({
    joined: true,
    username: me.username,
    rank: me.rank,
    used,
    limit: 10,
    beast: parseBeastData(me.beast_data)
  });
});

app.get("/api/beast-arena/nearby", auth, (req, res) => {
  const me = getBeastArenaPlayer(req.user.id);

  if (!me) {
    return res.status(400).json({ error: "请先配置斗兽排行灵兽" });
  }

  const rows = getBeastArenaNearbyRows(me).map(r => ({
    userId: r.user_id,
    username: r.username,
    rank: r.rank,
    beast: parseBeastData(r.beast_data),
    updatedAt: r.updated_at
  }));

  res.json({
    me: {
      username: me.username,
      rank: me.rank,
      beast: parseBeastData(me.beast_data)
    },
    rows
  });
});

app.post("/api/beast-arena/challenge", auth, (req, res) => {
  const targetUserId = Math.max(1, Math.floor(Number(req.body.targetUserId) || 0));

  if (!targetUserId) {
    return res.status(400).json({ error: "挑战目标错误" });
  }

  if (targetUserId === req.user.id) {
    return res.status(400).json({ error: "不能挑战自己" });
  }

  const d = todayKey();
  let payload = null;

  const tx = db.transaction(() => {
    const attacker = getBeastArenaPlayer(req.user.id);

    if (!attacker) {
      throw new Error("请先配置斗兽排行灵兽");
    }

    if (attacker.arena_date !== d) {
      db.prepare(`
        UPDATE beast_arena_players
        SET arena_date = ?, used = 0
        WHERE user_id = ?
      `).run(d, req.user.id);

      attacker.arena_date = d;
      attacker.used = 0;
    }

    if (attacker.used >= 10) {
      throw new Error("今日斗兽排行挑战次数已用完");
    }

    const defender = getBeastArenaPlayer(targetUserId);

    if (!defender) {
      throw new Error("目标玩家尚未进入斗兽排行");
    }

    const nearby = getBeastArenaNearbyRows(attacker).map(r => r.user_id);

    if (!nearby.includes(targetUserId)) {
      throw new Error("只能挑战排名附近五名玩家");
    }

    const aBeast = parseBeastData(attacker.beast_data);
    const dBeast = parseBeastData(defender.beast_data);

    if (!aBeast || !dBeast) {
      throw new Error("灵兽数据异常");
    }

    const sim = simulateServerBeastBattle(aBeast, dBeast);

    const attackerRankBefore = attacker.rank;
    const defenderRankBefore = defender.rank;

    let attackerRankAfter = attackerRankBefore;
    let defenderRankAfter = defenderRankBefore;

    if (sim.win && defender.rank < attacker.rank) {
      attackerRankAfter = defender.rank;
      defenderRankAfter = attacker.rank;

      db.prepare(`
        UPDATE beast_arena_players
        SET rank = ?
        WHERE user_id = ?
      `).run(attackerRankAfter, attacker.user_id);

      db.prepare(`
        UPDATE beast_arena_players
        SET rank = ?
        WHERE user_id = ?
      `).run(defenderRankAfter, defender.user_id);
    }

    db.prepare(`
      UPDATE beast_arena_players
      SET used = used + 1,
          arena_date = ?
      WHERE user_id = ?
    `).run(d, attacker.user_id);

    const reward = beastCoinRewardByRank(attackerRankAfter, sim.win);

    const result = readUserSaveById(req.user.id);

    if (result.error) {
      throw new Error(result.error);
    }

    const save = result.save;

    addPlayerResource(req.user.id, "beastCoins", reward);

    writeUserSave(req.user.id, save);

    const info = db.prepare(`
      INSERT INTO beast_arena_battles (
        attacker_user_id,
        defender_user_id,
        attacker_username,
        defender_username,
        attacker_rank_before,
        defender_rank_before,
        attacker_rank_after,
        defender_rank_after,
        win,
        coin_reward,
        log,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attacker.user_id,
      defender.user_id,
      attacker.username,
      defender.username,
      attackerRankBefore,
      defenderRankBefore,
      attackerRankAfter,
      defenderRankAfter,
      sim.win ? 1 : 0,
      reward,
      JSON.stringify(sim.log),
      Date.now()
    );

    payload = {
      ok: true,
      battleId: info.lastInsertRowid,
      win: sim.win,
      reward,
      log: sim.log,
      attackerRankBefore,
      defenderRankBefore,
      attackerRankAfter,
      defenderRankAfter,
      used: attacker.used + 1,
      limit: 10,
      save
    };
  });

  try {
    tx();
    res.json(payload);
  } catch (err) {
    res.status(400).json({ error: err.message || "斗兽挑战失败" });
  }
});

app.get("/api/beast-arena/battles", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT *
    FROM beast_arena_battles
    WHERE attacker_user_id = ?
       OR defender_user_id = ?
    ORDER BY id DESC
    LIMIT 20
  `).all(req.user.id, req.user.id);

  res.json(rows.map(r => ({
    id: r.id,
    attackerUsername: r.attacker_username,
    defenderUsername: r.defender_username,
    win: !!r.win,
    reward: r.coin_reward,
    log: (() => {
      try {
        return JSON.parse(r.log);
      } catch {
        return [];
      }
    })(),
    createdAt: r.created_at,
    attackerRankBefore: r.attacker_rank_before,
    defenderRankBefore: r.defender_rank_before,
    attackerRankAfter: r.attacker_rank_after,
    defenderRankAfter: r.defender_rank_after
  })));
});

app.post("/api/beast-arena/shop", auth, (req, res) => {
  const type = String(req.body.type || "").trim();
  const q = Math.max(0, Math.min(4, Math.floor(Number(req.body.q) || 0)));

  if (!["ore", "herb", "hide"].includes(type)) {
    return res.status(400).json({ error: "兑换材料类型错误" });
  }

  const costTable = [20, 40, 80, 160, 320];
  const countTable = [10, 8, 6, 4, 2];

  const cost = costTable[q];
  const count = countTable[q];

  const result = readUserSaveById(req.user.id);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const save = result.save;

  const resources = getPlayerResources(req.user.id, save);

if (num(resources.beastCoins) < cost) {
  return res.status(400).json({ error: "斗兽币不足" });
}

db.prepare(`
  UPDATE player_resources
  SET beastCoins = beastCoins - ?,
      updated_at = ?
  WHERE user_id = ?
`).run(cost, Date.now(), req.user.id);

  save.materials = save.materials || {};
  save.materials[type] = save.materials[type] || {};
  save.materials[type][q] = Math.max(0, Math.floor(Number(save.materials[type][q]) || 0)) + count;

  writeUserSave(req.user.id, save);

  res.json({
    ok: true,
    message: `兑换成功，获得材料×${count}`,
    save
  });
});
/* =========================
   交易行
========================= */

const AUCTION_EXPIRE_MS = 24 * 60 * 60 * 1000;

function cleanExpiredAuctions() {
  const now = Date.now();

  db.prepare(`
    UPDATE auction_listings
    SET status = 'expired',
        cancelled_at = ?
    WHERE status = 'active'
      AND expire_at > 0
      AND expire_at <= ?
  `).run(now, now);
}

function auctionPublicRow(row) {
  let item = null;

  try {
    item = JSON.parse(row.item_data);
  } catch {
    item = null;
  }

  return {
    id: row.id,
    sellerUsername: row.seller_username,
    buyerUsername: row.buyer_username,
    itemType: row.item_type || "equip",
    price: row.price,
    status: row.status,
    item,
    createdAt: row.created_at,
    expireAt: row.expire_at,
    soldAt: row.sold_at,
    cancelledAt: row.cancelled_at
  };
}

function isItemEquipped(save, itemId) {
  const equipped = save.equipped || {};
  return Object.values(equipped).includes(itemId);
}

function removeAuctionItemFromSave(save, itemType, itemId) {
  if (itemType === "equip") {
    save.inventory = Array.isArray(save.inventory) ? save.inventory : [];
    const item = save.inventory.find(i => i && i.id === itemId);

    if (!item) return { error: "云存档中没有找到该装备，请先保存存档" };

    if (!item.crafted) return { error: "只有炼器打造装备可以上架" };
    if (item.bound || item.tradeBound) return { error: "该装备已绑定，无法上架" };
    if (isItemEquipped(save, itemId)) return { error: "已穿戴装备不能上架" };

    save.inventory = save.inventory.filter(i => i && i.id !== itemId);

    return { item };
  }

  if (itemType === "pill") {
    save.pills = Array.isArray(save.pills) ? save.pills : [];
    const item = save.pills.find(i => i && i.id === itemId);

    if (!item) return { error: "云存档中没有找到该丹药，请先保存存档" };

    save.pills = save.pills.filter(i => i && i.id !== itemId);

    return { item };
  }

  if (itemType === "talisman") {
    save.talismans = Array.isArray(save.talismans) ? save.talismans : [];
    const item = save.talismans.find(i => i && i.id === itemId);

    if (!item) return { error: "云存档中没有找到该符箓，请先保存存档" };

    save.talismans = save.talismans.filter(i => i && i.id !== itemId);

    return { item };
  }

  if (itemType === "beast") {
    save.spiritBeasts = Array.isArray(save.spiritBeasts) ? save.spiritBeasts : [];
    const item = save.spiritBeasts.find(i => i && i.id === itemId);

    if (!item) return { error: "云存档中没有找到该灵兽，请先保存存档" };
    if (item.tradeBound) return { error: "该灵兽已绑定，无法上架" };
    if (save.activeBeastId === itemId) return { error: "出战中的灵兽不能上架" };

    save.spiritBeasts = save.spiritBeasts.filter(i => i && i.id !== itemId);

    return { item };
  }

  if (itemType === "net") {
    const q = Math.max(0, Math.floor(Number(itemId) || 0));

    save.beastNets = save.beastNets || {};
    save.beastNets[q] = Math.max(0, Math.floor(Number(save.beastNets[q]) || 0));

    if (save.beastNets[q] <= 0) {
      return { error: "该捕兽网数量不足" };
    }

    save.beastNets[q] -= 1;

    return {
      item: {
        id: "net_" + q + "_" + Date.now(),
        q,
        name: "捕兽网",
        count: 1
      }
    };
  }

  return { error: "不支持的上架类型" };
}

function addAuctionItemToSave(save, itemType, item) {
  if (itemType === "equip") {
    save.inventory = Array.isArray(save.inventory) ? save.inventory : [];
    save.inventory.push(item);
    return;
  }

  if (itemType === "pill") {
    save.pills = Array.isArray(save.pills) ? save.pills : [];
    save.pills.push(item);
    return;
  }

  if (itemType === "talisman") {
    save.talismans = Array.isArray(save.talismans) ? save.talismans : [];
    save.talismans.push(item);
    return;
  }

  if (itemType === "beast") {
    save.spiritBeasts = Array.isArray(save.spiritBeasts) ? save.spiritBeasts : [];
    save.spiritBeasts.push(item);
    return;
  }

  if (itemType === "net") {
    const q = Math.max(0, Math.floor(Number(item.q) || 0));
    save.beastNets = save.beastNets || {};
    save.beastNets[q] = Math.max(0, Math.floor(Number(save.beastNets[q]) || 0)) + 1;
    return;
  }
}

app.post("/api/auction/list", auth, (req, res) => {
  cleanExpiredAuctions();

  const itemId = String(req.body.itemId || "").trim();
  const itemType = String(req.body.itemType || "equip").trim();
  const price = Math.max(1, Math.floor(Number(req.body.price) || 0));

  if (!["equip", "pill", "talisman", "beast", "net"].includes(itemType)) {
    return res.status(400).json({ error: "上架类型错误" });
  }

  if (!itemId) {
    return res.status(400).json({ error: "物品错误" });
  }

  if (price < 1 || price > 999999999) {
    return res.status(400).json({ error: "价格不合法" });
  }

  const result = readUserSaveById(req.user.id);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const { save } = result;

  const removed = removeAuctionItemFromSave(save, itemType, itemId);

  if (removed.error) {
    return res.status(400).json({ error: removed.error });
  }

  const item = removed.item;
  const now = Date.now();

  const tx = db.transaction(() => {
    writeUserSave(req.user.id, save);

    db.prepare(`
      INSERT INTO auction_listings (
        seller_user_id,
        seller_username,
        item_type,
        item_data,
        price,
        status,
        created_at,
        expire_at
      )
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      req.user.id,
      req.user.username,
      itemType,
      JSON.stringify(item),
      price,
      now,
      now + AUCTION_EXPIRE_MS
    );
  });

  try {
    tx();

    res.json({
      ok: true,
      message: "上架成功，商品将在24小时后自动过期",
      save
    });
  } catch {
    res.status(500).json({ error: "上架失败" });
  }
});

app.get("/api/auction/listings", (req, res) => {
  cleanExpiredAuctions();

  const type = String(req.query.type || "all").trim();
  const keyword = String(req.query.keyword || "").trim();

  const rows = db.prepare(`
    SELECT *
    FROM auction_listings
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT 100
  `).all();

  let result = rows.map(auctionPublicRow);

  if (["equip", "pill", "talisman", "beast", "net"].includes(type)) {
    result = result.filter(r => r.itemType === type);
  }

  if (keyword) {
    result = result.filter(r => {
      const name = String(r.item?.name || "");
      const seller = String(r.sellerUsername || "");
      const affix = String(r.item?.affix?.name || "");
      return name.includes(keyword) || seller.includes(keyword) || affix.includes(keyword);
    });
  }

  res.json(result.slice(0, 50));
});

app.get("/api/auction/my", auth, (req, res) => {
  cleanExpiredAuctions();

  const rows = db.prepare(`
    SELECT *
    FROM auction_listings
    WHERE seller_user_id = ?
      AND status = 'active'
    ORDER BY id DESC
    LIMIT 50
  `).all(req.user.id);

  res.json(rows.map(auctionPublicRow));
});

app.get("/api/auction/history", auth, (req, res) => {
  cleanExpiredAuctions();

  const rows = db.prepare(`
    SELECT *
    FROM auction_listings
    WHERE status = 'sold'
    ORDER BY sold_at DESC
    LIMIT 50
  `).all();

  res.json(rows.map(auctionPublicRow));
});

app.post("/api/auction/cancel", auth, (req, res) => {
  cleanExpiredAuctions();

  const id = Math.max(1, Math.floor(Number(req.body.id) || 0));

  const listing = db.prepare(`
    SELECT *
    FROM auction_listings
    WHERE id = ?
      AND status = 'active'
  `).get(id);

  if (!listing) {
    return res.status(404).json({ error: "商品不存在或已处理" });
  }

  if (listing.seller_user_id !== req.user.id) {
    return res.status(403).json({ error: "只能下架自己的商品" });
  }

  const result = readUserSaveById(req.user.id);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const { save } = result;

  let item = null;

  try {
    item = JSON.parse(listing.item_data);
  } catch {
    return res.status(400).json({ error: "商品数据损坏" });
  }

  const tx = db.transaction(() => {
    addAuctionItemToSave(save, listing.item_type || "equip", item);

    writeUserSave(req.user.id, save);

    db.prepare(`
      UPDATE auction_listings
      SET status = 'cancelled',
          cancelled_at = ?
      WHERE id = ?
    `).run(Date.now(), id);
  });

  try {
    tx();

    res.json({
      ok: true,
      message: "下架成功，物品已返回背包",
      save
    });
  } catch {
    res.status(500).json({ error: "下架失败" });
  }
});

app.post("/api/auction/buy", auth, (req, res) => {
  cleanExpiredAuctions();

  const id = Math.max(1, Math.floor(Number(req.body.id) || 0));

  const listing = db.prepare(`
    SELECT *
    FROM auction_listings
    WHERE id = ?
      AND status = 'active'
  `).get(id);

  if (!listing) {
    return res.status(404).json({ error: "商品不存在、已售出或已过期" });
  }

  if (listing.expire_at && listing.expire_at <= Date.now()) {
    db.prepare(`
      UPDATE auction_listings
      SET status = 'expired',
          cancelled_at = ?
      WHERE id = ?
    `).run(Date.now(), id);

    return res.status(400).json({ error: "商品已过期" });
  }

  if (listing.seller_user_id === req.user.id) {
    return res.status(400).json({ error: "不能购买自己上架的商品" });
  }

  const buyerResult = readUserSaveById(req.user.id);

  if (buyerResult.error) {
    return res.status(400).json({ error: buyerResult.error });
  }

  const sellerResult = readUserSaveById(listing.seller_user_id);

  if (sellerResult.error) {
    return res.status(400).json({ error: "卖家存档异常，暂时无法购买" });
  }

  const buyerSave = buyerResult.save;
  const sellerSave = sellerResult.save;

  const buyerRes = getPlayerResources(req.user.id, buyerSave);
const sellerRes = getPlayerResources(listing.seller_user_id, sellerSave);

if (num(buyerRes.yuanbao) < listing.price) {
  return res.status(400).json({ error: "元宝不足" });
}

  let item = null;

  try {
    item = JSON.parse(listing.item_data);
  } catch {
    return res.status(400).json({ error: "商品数据损坏" });
  }

  const tax = Math.floor(listing.price * 0.08);
  const sellerGain = listing.price - tax;

  const tx = db.transaction(() => {
    db.prepare(`
  UPDATE player_resources
  SET yuanbao = yuanbao - ?,
      updated_at = ?
  WHERE user_id = ?
`).run(listing.price, Date.now(), req.user.id);

db.prepare(`
  UPDATE player_resources
  SET yuanbao = yuanbao + ?,
      updated_at = ?
  WHERE user_id = ?
`).run(sellerGain, Date.now(), listing.seller_user_id);

addAuctionItemToSave(buyerSave, listing.item_type || "equip", item);

writeUserSave(req.user.id, buyerSave);
writeUserSave(listing.seller_user_id, sellerSave);

    db.prepare(`
      UPDATE auction_listings
      SET status = 'sold',
          buyer_user_id = ?,
          buyer_username = ?,
          sold_at = ?
      WHERE id = ?
    `).run(
      req.user.id,
      req.user.username,
      Date.now(),
      id
    );
  });

  try {
    tx();

    res.json({
      ok: true,
      message: `购买成功，卖家获得 ${sellerGain} 元宝，手续费 ${tax} 元宝`,
      save: buyerSave
    });
  } catch {
    res.status(500).json({ error: "购买失败" });
  }
});
/* =========================
   GM 后台接口
========================= */

app.post("/api/gm/grant", gmAuth, (req, res) => {
  const username = String(req.body.username || "").trim();
  const type = String(req.body.type || "").trim();
  const amount = Math.max(1, Math.floor(Number(req.body.amount) || 0));

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

  function makeId(prefix = "gm") {
    return prefix + "_" + Date.now() + "_" + Math.random().toString(16).slice(2);
  }

  function clampInt(value, min, max, fallback = min) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function addToObjectNumber(obj, key, n) {
    obj[key] = Math.max(0, Math.floor(Number(obj[key]) || 0)) + n;
  }

  function addMaterial(materialType, quality, n) {
    if (!["ore", "herb", "hide"].includes(materialType)) {
      return { error: "材料类型错误" };
    }

    save.materials = save.materials || {};
    save.materials.ore = save.materials.ore || {};
    save.materials.herb = save.materials.herb || {};
    save.materials.hide = save.materials.hide || {};

    addToObjectNumber(save.materials[materialType], quality, n);

    return { ok: true };
  }

  function pillDefaultValue(stage, grade, stat) {
    const stageList = ["fan", "ling", "tian", "di", "xian", "shen"];
    const gradeMult = {
      low: 0.7,
      mid: 1,
      high: 1.45
    };

    const stageIndex = Math.max(0, stageList.indexOf(stage));
    const base = stageIndex + 1;
    const mult = gradeMult[grade] || 1;

    if (stat === "power") return Math.max(1, Math.floor(base * 3 * mult));
    if (stat === "exp") return Number((base * 0.001 * mult).toFixed(4));
    if (stat === "yb") return Number((base * 0.001 * mult).toFixed(4));
    if (stat === "gear") return Number((base * 0.0006 * mult).toFixed(4));
    if (stat === "kill") return Number((base * 0.0008 * mult).toFixed(4));

    return 1;
  }

  function makePill() {
    const stage = String(req.body.pillStage || "fan").trim();
    const grade = String(req.body.pillGrade || "low").trim();
    const stat = String(req.body.pillStat || "power").trim();
    const customName = String(req.body.pillName || "").trim();
    const customValue = req.body.pillValue;

    const stageNames = {
      fan: "凡阶",
      ling: "灵阶",
      tian: "天阶",
      di: "地阶",
      xian: "仙阶",
      shen: "神阶"
    };

    const gradeNames = {
      low: "下等",
      mid: "中等",
      high: "上等"
    };

    if (!stageNames[stage]) return { error: "丹药阶级错误" };
    if (!gradeNames[grade]) return { error: "丹药品级错误" };

    const allowedStats = ["power", "exp", "yb", "gear", "kill"];
    if (!allowedStats.includes(stat)) return { error: "丹药属性错误" };

    const value = customValue === "" || customValue === undefined || customValue === null
      ? pillDefaultValue(stage, grade, stat)
      : Number(customValue);

    if (!Number.isFinite(value) || value < 0) {
      return { error: "丹药效果值错误" };
    }

    return {
      item: {
        id: makeId("pill"),
        stage,
        grade,
        stat,
        value,
        name: customName || `GM发放·${stageNames[stage]}${gradeNames[grade]}丹药`,
        createdAt: Date.now()
      }
    };
  }

  function talismanDefaultValue(stage) {
    const base = {
      fan: 0.08,
      ling: 0.14,
      tian: 0.22,
      di: 0.32,
      xian: 0.45,
      shen: 0.65
    };

    return base[stage] || 0.08;
  }

  function makeTalisman() {
    const stage = String(req.body.talismanStage || "fan").trim();
    const talismanType = String(req.body.talismanType || "power").trim();
    const customName = String(req.body.talismanName || "").trim();
    const customValue = req.body.talismanValue;
    const durationMinuteInput = req.body.talismanDuration;

    const stageNames = {
      fan: "凡阶",
      ling: "灵阶",
      tian: "天阶",
      di: "地阶",
      xian: "仙阶",
      shen: "神阶"
    };

    const typeNames = {
      power: "战力符",
      exp: "聚灵符",
      yb: "聚宝符",
      gear: "寻宝符",
      kill: "疾杀符"
    };

    if (!stageNames[stage]) return { error: "符箓阶级错误" };
    if (!typeNames[talismanType]) return { error: "符箓类型错误" };

    const value = customValue === "" || customValue === undefined || customValue === null
      ? talismanDefaultValue(stage)
      : Number(customValue);

    if (!Number.isFinite(value) || value < 0) {
      return { error: "符箓加成值错误" };
    }

    const durationMinutes = durationMinuteInput === "" || durationMinuteInput === undefined || durationMinuteInput === null
      ? 60
      : Math.max(1, Math.floor(Number(durationMinuteInput) || 60));

    return {
      item: {
        id: makeId("talisman"),
        stage,
        type: talismanType,
        value,
        duration: durationMinutes * 60 * 1000,
        name: customName || `GM发放·${stageNames[stage]}${typeNames[talismanType]}`,
        createdAt: Date.now()
      }
    };
  }

  function calcBeastStats(beast) {
    const level = Math.max(1, Math.floor(Number(beast.level) || 1));
    const q = Math.max(0, Math.floor(Number(beast.q) || 0));
    const aptitude = Math.max(1, Math.floor(Number(beast.aptitude) || 1));
    const affinityValue = Math.max(0, Math.min(100, Math.floor(Number(beast.affinity) || 0)));
    const affinity = affinityValue >= 80 ? 1.2 : 0.6 + affinityValue / 80 * 0.6;
    const evolve = 1 + Math.max(0, Math.floor(Number(beast.evolve) || 0)) * 0.08;

    const qMult = 1 + q * 0.16;
    const aptMult = 0.7 + aptitude / 100 * 0.8;
    const beastType = beast.type || "support";

    let hp = 100 + level * 18;
    let atk = 18 + level * 4;
    let def = 8 + level * 2.4;
    let spd = 10 + level * 1.8;
    let crit = 0.05 + q * 0.006 + aptitude * 0.0008;

    if (beastType === "battle") {
      hp *= 1.08;
      atk *= 1.22;
      def *= 1.05;
      spd *= 1.05;
      crit += 0.03;
    } else {
      hp *= 1.18;
      atk *= 0.9;
      def *= 1.16;
      spd *= 1.08;
    }

    return {
      hp: Math.floor(hp * qMult * aptMult * affinity * evolve),
      atk: Math.floor(atk * qMult * aptMult * affinity * evolve),
      def: Math.floor(def * qMult * aptMult * affinity * evolve),
      spd: Math.floor(spd * qMult * aptMult * affinity * evolve),
      crit: Math.min(0.45, crit * affinity)
    };
  }

  function makeSpiritBeast(index) {
    const beastName = String(req.body.beastName || "").trim() || "GM发放灵兽";
    const q = clampInt(req.body.beastQuality, 0, 10, 0);
    const beastType = String(req.body.beastType || "support").trim();
    const level = clampInt(req.body.beastLevel, 1, 100, 1);
    const aptitude = clampInt(req.body.beastAptitude, 1, 100, 80);
    const affinity = clampInt(req.body.beastAffinity, 0, 100, 0);
    const evolve = Math.max(0, Math.floor(Number(req.body.beastEvolve) || 0));
    const appraised = !!req.body.beastAppraised;
    const tradeBound = !!req.body.beastTradeBound;

    if (!["battle", "support"].includes(beastType)) {
      return { error: "灵兽类型错误" };
    }

    const beast = {
      id: makeId("beast"),
      name: amount > 1 ? `${beastName}${index + 1}` : beastName,
      q,
      type: beastType,
      level,
      exp: 0,
      affinity,
      evolve,
      tradeBound,
      appraised,
      aptitude: appraised ? aptitude : 0,
      beastStats: null,
      activeSkill: String(req.body.beastActiveSkill || "").trim() || "GM神赐",
      passiveSkill: String(req.body.beastPassiveSkill || "").trim() || "GM祝福",
      caughtAt: Date.now()
    };

    if (appraised) {
      beast.beastStats = calcBeastStats(beast);
    }

    return { item: beast };
  }

  try {
    if (type === "yuanbao") {
      addPlayerResource(user.id, "yuanbao", amount);
    } else if (type === "copper") {
      addPlayerResource(user.id, "copper", amount);
    } else if (type === "forgeStones") {
      addPlayerResource(user.id, "forgeStones", amount);
    } else if (type === "vipExp") {
      addPlayerResource(user.id, "vipExp", amount);
    } else if (type === "guildToken") {
      addPlayerResource(user.id, "guildToken", amount);
    } else if (type === "fateRerollStones") {
      addPlayerResource(user.id, "fateRerollStones", amount);
    } else if (type === "beastCoins") {
      addPlayerResource(user.id, "beastCoins", amount);
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
    } else if (type === "universalShard") {
      const shardQuality = String(req.body.shardQuality || "").trim();
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
      addToObjectNumber(save.universalShards, shardQuality, amount);
    } else if (type === "material") {
      const materialType = String(req.body.materialType || "").trim();
      const materialQuality = clampInt(req.body.materialQuality, 0, 13, 0);
      const added = addMaterial(materialType, materialQuality, amount);

      if (added.error) {
        return res.status(400).json({ error: added.error });
      }
    } else if (type === "beastNet") {
      const netQuality = clampInt(req.body.netQuality, 0, 13, 0);

      save.beastNets = save.beastNets || {};
      addToObjectNumber(save.beastNets, netQuality, amount);
    } else if (type === "pill") {
      save.pills = Array.isArray(save.pills) ? save.pills : [];

      for (let i = 0; i < amount; i++) {
        const made = makePill();

        if (made.error) {
          return res.status(400).json({ error: made.error });
        }

        save.pills.unshift(made.item);
      }

      save.pills = save.pills.slice(0, 300);
    } else if (type === "talisman") {
      save.talismans = Array.isArray(save.talismans) ? save.talismans : [];

      for (let i = 0; i < amount; i++) {
        const made = makeTalisman();

        if (made.error) {
          return res.status(400).json({ error: made.error });
        }

        save.talismans.unshift(made.item);
      }

      save.talismans = save.talismans.slice(0, 300);
    } else if (type === "spiritBeast") {
      save.spiritBeasts = Array.isArray(save.spiritBeasts) ? save.spiritBeasts : [];

      for (let i = 0; i < amount; i++) {
        const made = makeSpiritBeast(i);

        if (made.error) {
          return res.status(400).json({ error: made.error });
        }

        save.spiritBeasts.unshift(made.item);
      }

      save.spiritBeasts = save.spiritBeasts.slice(0, 200);
    } else {
      return res.status(400).json({ error: "不支持的发放类型" });
    }

    writeUserSave(user.id, save);

    res.json({
      ok: true,
      message: `已向 ${user.username} 发放 ${amount} 个/点：${type}`
    });
  } catch (err) {
    res.status(500).json({
      error: "GM发放失败：" + (err.message || err)
    });
  }
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

  db.prepare(`
    DELETE FROM arena_players
    WHERE user_id = ?
  `).run(user.id);

  res.json({
    ok: true,
    message: `${user.username} 已被封号，并已从排行榜和竞技场移除`
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

  setPlayerResource(user.id, "yuanbao", 0);

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
app.get("/game.html", (req, res) => {
  res.sendFile(path.join(__dirname, "game.html"));
});
app.get("/gm.html", (req, res) => {
  res.sendFile(path.join(__dirname, "gm.html"));
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("服务器已启动，端口：" + PORT);
});