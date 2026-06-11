const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const db = new Database("game.db");

const JWT_SECRET = "nanli_change_this_to_a_long_random_secret_123456";
const GM_SECRET = "010212zp";
app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  save_data TEXT,
  save_updated_at INTEGER NOT NULL DEFAULT 0
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

const userColumns = db.prepare(`PRAGMA table_info(users)`).all().map(col => col.name);

if (!userColumns.includes("save_data")) {
  db.exec(`ALTER TABLE users ADD COLUMN save_data TEXT`);
}

if (!userColumns.includes("save_updated_at")) {
  db.exec(`ALTER TABLE users ADD COLUMN save_updated_at INTEGER NOT NULL DEFAULT 0`);
}

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


gpt-5.5 | 111
06/12 00:18
可以做。你现在最适合做的是：GM 后台直接修改玩家云存档里的数据，比如发元宝、锻造石、经验丹、VIP经验、万能碎片。

因为你已经有 /api/save 云存档，玩家数据都存在 users.save_data 里面，所以 GM 后台本质就是：

GM 登录后台。
输入玩家用户名。
选择发什么道具。
后端读取该玩家 save_data。
修改里面的数值。
保存回数据库。
玩家下次登录/加载云存档后收到道具。
一、先说安全要求
GM 后台一定不能公开给普通玩家用。

最简单做法：

后台地址用 /gm.html
后端接口用 /api/gm/grant
请求时必须带一个 GM 密钥
GM 密钥不要写在前端公开页面里
比如你设置：

Js
const GM_SECRET = "nanli_gm_改成很长很难猜的密码_9527";
以后你在 GM 后台输入这个密钥才能发道具。

二、修改 server.js
在 server.js 顶部这里：

Js
const JWT_SECRET = "nanli_change_this_to_a_long_random_secret_123456";
下面加一行：

Js
const GM_SECRET = "nanli_gm_change_this_to_a_long_random_secret_9527";
你可以把后面的字符串改成自己的复杂密码。

三、继续在 server.js 增加 GM 接口
找到这段：

Js
app.get("/api/ranking", (req, res) => {
在它前面，粘贴下面代码：

Js
function gmAuth(req, res, next) {
  const secret = String(req.headers["x-gm-secret"] || "");
  if (secret !== GM_SECRET) {
    return res.status(403).json({ error: "GM密钥错误" });
  }
  next();
}
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
  const user = db.prepare(`
    SELECT id, username, save_data
    FROM users
    WHERE username = ?
  `).get(username);
  if (!user) {
    return res.status(404).json({ error: "玩家不存在" });
  }
  let save;
  try {
    save = user.save_data ? JSON.parse(user.save_data) : null;
  } catch {
    save = null;
  }
  if (!save || typeof save !== "object") {
    return res.status(400).json({ error: "该玩家暂无云存档，请让玩家先登录并保存一次" });
  }
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
  } else if (type === "universalShard") {
    const allowed = ["normal", "good", "rare", "epic", "legend", "myth", "supreme", "chroma", "god", "black"];
    if (!allowed.includes(shardQuality)) {
      return res.status(400).json({ error: "万能碎片品质错误" });
    }
    save.universalShards = save.universalShards || {};
    save.universalShards[shardQuality] = Math.max(0, Math.floor(Number(save.universalShards[shardQuality]) || 0)) + amount;
  } else {
    return res.status(400).json({ error: "不支持的发放类型" });
  }
  save.last = Date.now();
  db.prepare(`
    UPDATE users
    SET save_data = ?, save_updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(save), Date.now(), user.id);
  res.json({
    ok: true,
    message: `已向 ${user.username} 发放成功`
  });
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