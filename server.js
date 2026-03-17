const express  = require("express");
const multer   = require("multer");
const fetch    = require("node-fetch");
const path     = require("path");
const os       = require("os");
const { Pool } = require("pg");

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const db = {
  query: (text, params) => pool.query(text, params),
  one:   async (text, params) => { const r = await pool.query(text, params); return r.rows[0] || null; },
  all:   async (text, params) => { const r = await pool.query(text, params); return r.rows; },
  run:   (text, params) => pool.query(text, params),
};

async function initDB() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS stores (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      color      TEXT NOT NULL DEFAULT '#1f7a4a',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await db.run(`
    CREATE TABLE IF NOT EXISTS markets (
      id         SERIAL PRIMARY KEY,
      market     TEXT NOT NULL,
      color      TEXT NOT NULL,
      date       TEXT NOT NULL,
      date_end   TEXT,
      tiles      INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await db.run(`
    CREATE TABLE IF NOT EXISTS items (
      id        SERIAL PRIMARY KEY,
      market_id INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      price     TEXT NOT NULL,
      original  TEXT,
      category  TEXT,
      promo     TEXT,
      image     TEXT,
      fav       BOOLEAN DEFAULT FALSE
    )`);
  console.log("✅ Banco de dados pronto");
}

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const n of Object.keys(nets))
    for (const net of nets[n])
      if (net.family === "IPv4" && !net.internal) return net.address;
  return "localhost";
}

// ── Tiling ────────────────────────────────────────────────────────────────────
async function splitImageToTiles(buffer) {
  try {
    const sharp = require("sharp");
    const meta  = await sharp(buffer).metadata();
    const W = meta.width, H = meta.height;
    const isDoublePage = W > H * 1.3;
    const isDense      = W * H > 2_000_000;
    let cols, rows;
    if (isDoublePage) { cols = 2; rows = isDense ? 4 : 3; }
    else              { cols = 1; rows = isDense ? 3 : (H > 1200 ? 2 : 1); }
    const tileW = Math.ceil(W / cols);
    const tileH = Math.ceil(H / rows);
    const ov    = 0.08;
    const tiles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const left   = Math.max(0, Math.floor(c * tileW - tileW * ov));
        const top    = Math.max(0, Math.floor(r * tileH - tileH * ov));
        const width  = Math.min(tileW + Math.ceil(tileW * ov * 2), W - left);
        const height = Math.min(tileH + Math.ceil(tileH * ov * 2), H - top);
        let buf = await sharp(buffer).extract({ left, top, width, height }).toBuffer();
        const tm = await sharp(buf).metadata();
        if (tm.width > 1200) buf = await sharp(buf).resize({ width: 1200 }).toBuffer();
        const fm = await sharp(buf).metadata();
        tiles.push({ base64: buf.toString("base64"), buffer: buf, width: fm.width, height: fm.height,
                     index: r*cols+c, total: rows*cols, row:r, col:c, cols, rows });
      }
    }
    return tiles;
  } catch(_) {
    return [{ base64: buffer.toString("base64"), buffer, width:800, height:600,
              index:0, total:1, row:0, col:0, cols:1, rows:1 }];
  }
}

async function cropProductImage(tileBuffer, tileW, tileH, bbox) {
  try {
    const sharp = require("sharp");
    const [x1r,y1r,x2r,y2r] = bbox.map(v => Math.min(1, Math.max(0, v)));
    const left   = Math.round(x1r * tileW);
    const top    = Math.round(y1r * tileH);
    const width  = Math.max(10, Math.round((x2r-x1r) * tileW));
    const height = Math.max(10, Math.round((y2r-y1r) * tileH));
    if (left+width > tileW || top+height > tileH) return null;
    const padX = Math.round(width * 0.03), padY = Math.round(height * 0.03);
    const safeL = Math.max(0, left-padX), safeT = Math.max(0, top-padY);
    const safeW = Math.min(tileW-safeL, width+padX*2);
    const safeH = Math.min(tileH-safeT, height+padY*2);
    const cropped = await sharp(tileBuffer)
      .extract({ left: safeL, top: safeT, width: safeW, height: safeH })
      .resize({ width: 300, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return "data:image/jpeg;base64," + cropped.toString("base64");
  } catch(_) { return null; }
}

function buildPrompt(index, total, row, col, cols, rows) {
  const pos = total > 1
    ? `Seção ${index+1}/${total} de um folheto de supermercado brasileiro.`
    : "Folheto de supermercado brasileiro.";
  return `${pos}

Liste TODOS os produtos com preço visível. Para folhetos com "PAGUE APENAS" ou preço "CLIENTE", use o menor preço como "price". Inclua marca e gramatura no nome.

Responda SOMENTE com este JSON (sem markdown):
{"items":[{"name":"marca + produto + quantidade","price":"R$ X,XX","original":"R$ X,XX","category":"Carnes|Aves|Peixes|Frios|Laticínios|Padaria|Graos|Hortifruti|Bebidas|Cervejas|Higiene|Limpeza|Congelados|Mercearia|Outros","promo":"ex: Leve 4 Pague 3 ou vazio","bbox":[x1,y1,x2,y2]}]}

bbox = coordenadas do produto em proporção 0.0-1.0 [esquerda,cima,direita,baixo].
Se não houver produtos: {"items":[]}`;
}

// Modelos com suporte a visão, em ordem de preferência
const VISION_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.2-90b-vision-preview",
  "llama-3.2-11b-vision-preview",
];

async function callGroq(apiKey, model, mimeType, base64, promptText) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0.1,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: "text", text: promptText }
        ]
      }]
    })
  });

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function extractItems(raw, tileIdx) {
  if (!raw) { console.warn(`[tile ${tileIdx}] Resposta vazia`); return []; }

  console.log(`[tile ${tileIdx}] Resposta (${raw.length} chars): ${raw.substring(0, 150)}`);

  // Find outermost JSON object
  const start = raw.indexOf("{");
  const end   = raw.lastIndexOf("}");
  if (start === -1 || end === -1) {
    console.warn(`[tile ${tileIdx}] JSON não encontrado`);
    return [];
  }

  try {
    const parsed = JSON.parse(raw.substring(start, end + 1));
    const items  = parsed.items || [];
    console.log(`[tile ${tileIdx}] ✅ ${items.length} produtos`);
    return items;
  } catch(e) {
    // Last resort: try to extract individual item objects with regex
    console.warn(`[tile ${tileIdx}] Parse falhou, tentando extração parcial...`);
    const matches = raw.matchAll(/"name"\s*:\s*"([^"]+)"[^}]+"price"\s*:\s*"([^"]+)"/g);
    const items = [];
    for (const m of matches) {
      items.push({ name: m[1], price: m[2], original: "", category: "Mercearia", promo: "", bbox: [] });
    }
    console.log(`[tile ${tileIdx}] Extração parcial: ${items.length} produtos`);
    return items;
  }
}

async function analyzeTile(tile, mimeType, apiKey) {
  console.log(`[tile ${tile.index+1}/${tile.total}] Iniciando... (${tile.width}x${tile.height}px)`);
  const promptText = buildPrompt(tile.index, tile.total, tile.row, tile.col, tile.cols, tile.rows);

  let raw = "";
  let usedModel = "";

  // Try each model in order until one works
  for (const model of VISION_MODELS) {
    try {
      console.log(`[tile ${tile.index+1}] Tentando modelo: ${model}`);
      raw = await callGroq(apiKey, model, mimeType, tile.base64, promptText);
      usedModel = model;
      console.log(`[tile ${tile.index+1}] Modelo OK: ${model}`);
      break;
    } catch(err) {
      console.warn(`[tile ${tile.index+1}] Modelo ${model} falhou: ${err.message}`);
      // Wait a bit before trying next model
      await new Promise(r => setTimeout(r, 600));
    }
  }

  if (!raw) {
    console.error(`[tile ${tile.index+1}] Todos os modelos falharam`);
    return [];
  }

  const items = extractItems(raw, tile.index + 1);

  // Crop images for each item
  return Promise.all(items.map(async item => {
    let image = null;
    if (Array.isArray(item.bbox) && item.bbox.length === 4) {
      const [x1, y1, x2, y2] = item.bbox;
      if (x2 > x1 && y2 > y1 && x1 >= 0 && y1 >= 0 && x2 <= 1 && y2 <= 1) {
        image = await cropProductImage(tile.buffer, tile.width, tile.height, item.bbox);
      }
    }
    return { ...item, image };
  }));
}

function dedup(items) {
  const seen = new Map(); const result = [];
  for (const item of items) {
    const key = item.name.toLowerCase().replace(/[^a-záéíóúàâêôãõç0-9]/g,"").substring(0,25);
    if (!seen.has(key)) { seen.set(key, result.length); result.push(item); }
    else {
      const i = seen.get(key);
      if (item.promo && !result[i].promo) result[i].promo = item.promo;
      if (item.image && !result[i].image) result[i].image = item.image;
    }
  }
  return result;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get("/api/stores", async (req, res) => {
  try { res.json(await db.all("SELECT * FROM stores ORDER BY name ASC")); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/stores", async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Nome obrigatório." });
    const store = await db.one(
      "INSERT INTO stores (name, color) VALUES ($1,$2) RETURNING *",
      [name.trim(), color || "#1f7a4a"]
    );
    res.json(store);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Mercado já cadastrado." });
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/stores/:id", async (req, res) => {
  try { await db.run("DELETE FROM stores WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/stores/:id", async (req, res) => {
  try {
    const { name, color } = req.body;
    const store = await db.one("UPDATE stores SET name=$1,color=$2 WHERE id=$3 RETURNING *", [name.trim(), color, req.params.id]);
    res.json(store);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/markets", async (req, res) => {
  try {
    const markets = await db.all("SELECT * FROM markets ORDER BY created_at DESC");
    const result  = await Promise.all(markets.map(async m => ({
      id: m.id, market: m.market, color: m.color,
      date: m.date, date_end: m.date_end || null, tiles: m.tiles,
      items: (await db.all("SELECT * FROM items WHERE market_id=$1", [m.id])).map(i => ({ ...i, fav: Boolean(i.fav) })),
    })));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) return res.status(401).json({ error: "Chave de API ausente." });
    if (!req.file) return res.status(400).json({ error: "Nenhuma imagem enviada." });
    const typeMap  = { "image/jpeg":"image/jpeg","image/jpg":"image/jpeg","image/png":"image/png","image/webp":"image/webp" };
    const mimeType = typeMap[req.file.mimetype] || "image/jpeg";
    const market   = req.body.market    || "Mercado";
    const color    = req.body.color     || "#1f7a4a";
    const dateEnd  = req.body.date_end  || null;
    const date     = req.body.date_start || new Date().toLocaleDateString("pt-BR");
    const tiles    = await splitImageToTiles(req.file.buffer);
    const allItems = [];
    for (let i = 0; i < tiles.length; i += 2) {
      const results = await Promise.all(tiles.slice(i, i+2).map(t => analyzeTile(t, mimeType, apiKey)));
      results.forEach(r => allItems.push(...r));
      if (i+2 < tiles.length) await new Promise(r => setTimeout(r, 800));
    }
    const items  = dedup(allItems);
    const mktRow = await db.one(
      "INSERT INTO markets (market,color,date,date_end,tiles) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [market, color, date, dateEnd, tiles.length]
    );
    for (const item of items) {
      await db.run(
        "INSERT INTO items (market_id,name,price,original,category,promo,image) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [mktRow.id, item.name, item.price, item.original||"", item.category||"Outros", item.promo||"", item.image||null]
      );
    }
    res.json({ id: mktRow.id, market, color, date, date_end: dateEnd, tiles: tiles.length,
               items: items.map(i => ({ ...i, fav: false })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/items/:id/fav", async (req, res) => {
  try { await db.run("UPDATE items SET fav=$1 WHERE id=$2", [req.body.fav, req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/markets/:id", async (req, res) => {
  try { await db.run("DELETE FROM markets WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, "0.0.0.0", async () => {
    const total = await db.one("SELECT COUNT(*) as n FROM markets");
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║             🥦 OfertaBot Web                 ║");
    console.log("╠══════════════════════════════════════════════╣");
    if (process.env.DATABASE_URL) {
      console.log("║  🌐 Rodando na nuvem (Render)                ║");
    } else {
      console.log(`║  Local: http://localhost:${PORT}                ║`);
      console.log(`║  Rede:  http://${getLocalIP()}:${PORT}          ║`);
    }
    console.log(`║  📦 ${total.n} folheto(s) no banco               ║`);
    console.log("╚══════════════════════════════════════════════╝\n");
  });
}).catch(err => {
  console.error("❌ Erro ao conectar ao banco:", err.message);
  process.exit(1);
});
