const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const db = new Database("game.db");

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
    return { yb: 100000, forge: 30000, fate: 2, black: 2, god: 1, rare: 0, legend: 0 };
  }

  if (rank === 2) {
    return { yb: 70000, forge: 22000, fate: 2, black: 2, god: 0, rare: 0, legend: 0 };
  }

  if (rank === 3) {
    return { yb: 50000, forge: 16000, fate: 1, black: 1, god: 0, rare: 0, legend: 0 };
  }

  if (rank <= 10) {
    return { yb: 30000, forge: 10000, fate: 1, black: 0, god: 0, rare: 0, legend: 3 };
  }

  if (rank <= 50) {
    return { yb: 15000, forge: 5000, fate: 0, black: 0, god: 0, rare: 5, legend: 0 };
  }

  return { yb: 3000, forge: 1000, fate: 0, black: 0, god: 0, rare: 0, legend: 0 };
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

  db.prepare(`
    UPDATE arena_players
    SET power = ?, level = ?, vip = ?, updated_at = ?
    WHERE user_id = ?
  `).run(power, level, vip, Date.now(), req.user.id);

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
    SET level = ?, vip = ?, updated_at = ?
    WHERE user_id = ?
  `).run(level, vip, Date.now(), req.user.id);
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

  save.yuanbao = Math.max(0, Math.floor(Number(save.yuanbao) || 0)) + reward.yb;
  save.forgeStones = Math.max(0, Math.floor(Number(save.forgeStones) || 0)) + reward.forge;
  save.fateRerollStones = Math.max(0, Math.floor(Number(save.fateRerollStones) || 0)) + reward.fate;

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