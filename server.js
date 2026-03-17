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
  one: async (t, p) => { const r = await pool.query(t, p); return r.rows[0] || null; },
  all: async (t, p) => { const r = await pool.query(t, p); return r.rows; },
  run: (t, p) => pool.query(t, p),
};

async function initDB() {
  await db.run(`CREATE TABLE IF NOT EXISTS stores (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL DEFAULT '#1f7a4a', created_at TIMESTAMP DEFAULT NOW())`);
  await db.run(`CREATE TABLE IF NOT EXISTS markets (id SERIAL PRIMARY KEY, market TEXT NOT NULL, color TEXT NOT NULL, date TEXT NOT NULL, date_end TEXT, tiles INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT NOW())`);
  await db.run(`CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, market_id INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE, name TEXT NOT NULL, price TEXT NOT NULL, original TEXT, category TEXT, promo TEXT, image TEXT, fav BOOLEAN DEFAULT FALSE)`);
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
    const isVeryDense  = W * H > 4_000_000;
    const isDense      = W * H > 2_000_000;
    let cols, rows;
    if (isDoublePage) { cols = 2; rows = isVeryDense ? 5 : isDense ? 4 : 3; }
    else              { cols = 1; rows = isVeryDense ? 4 : isDense ? 3 : (H > 1200 ? 2 : 1); }
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
    console.log(`Tiling: ${W}x${H}px → ${cols}x${rows} = ${tiles.length} tiles`);
    return tiles;
  } catch(_) {
    return [{ base64: buffer.toString("base64"), buffer, width:800, height:600,
              index:0, total:1, row:0, col:0, cols:1, rows:1 }];
  }
}

// ── Crop image ────────────────────────────────────────────────────────────────
async function cropProductImage(tileBuffer, tileW, tileH, bbox) {
  try {
    const sharp = require("sharp");
    let [x1r, y1r, x2r, y2r] = bbox.map(v => Math.min(1, Math.max(0, Number(v) || 0)));
    if ((x2r - x1r) < 0.05 || (y2r - y1r) < 0.05) return null;

    // Always crop top 60% of card (product photo, not price tag)
    const cardH = y2r - y1r;
    y2r = y1r + cardH * 0.60;

    const pad = 0.02;
    const left   = Math.floor(Math.max(0, x1r - pad) * tileW);
    const top    = Math.floor(Math.max(0, y1r - pad) * tileH);
    const width  = Math.max(20, Math.floor((Math.min(1, x2r + pad) - Math.max(0, x1r - pad)) * tileW));
    const height = Math.max(20, Math.floor((Math.min(1, y2r + pad) - Math.max(0, y1r - pad)) * tileH));
    const safeW  = Math.min(width,  tileW - left);
    const safeH  = Math.min(height, tileH - top);
    if (safeW < 10 || safeH < 10) return null;

    const cropped = await sharp(tileBuffer)
      .extract({ left, top, width: safeW, height: safeH })
      .resize({ width: 300, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return "data:image/jpeg;base64," + cropped.toString("base64");
  } catch(err) {
    console.warn("cropProductImage error:", err.message);
    return null;
  }
}

// ── Models ────────────────────────────────────────────────────────────────────
const VISION_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",  // fallback vision model
];

async function callGroq(apiKey, model, mimeType, base64, promptText, maxTokens = 4096, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature: 0.1,
        messages: [{ role: "user", content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: "text", text: promptText }
        ]}]
      })
    });

    if (res.ok) return (await res.json()).choices?.[0]?.message?.content?.trim() || "";

    const e = await res.json().catch(() => ({}));
    const msg = e?.error?.message || `HTTP ${res.status}`;

    // Rate limit — wait the suggested time + buffer then retry same model
    if (res.status === 429) {
      const waitMatch = msg.match(/try again in ([\d.]+)s/i);
      const waitMs    = waitMatch ? Math.ceil(parseFloat(waitMatch[1]) * 1000) + 500 : 3000;
      console.warn(`  [rate-limit] ${model} — aguardando ${waitMs}ms (tentativa ${attempt+1}/${retries})`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;  // retry same model
    }

    throw new Error(msg);
  }
  throw new Error(`Rate limit persistente após ${retries} tentativas`);
}

// ── PASS 1: Extract products (no bbox = shorter JSON = no truncation) ─────────
function buildExtractPrompt(index, total) {
  const pos = total > 1 ? `Secao ${index+1} de ${total} de um folheto.` : "Folheto de supermercado brasileiro.";
  return `${pos}
Liste TODOS os produtos com preco visivel. Regras:
- name: marca + produto + quantidade. Ex: "Arroz Tio Joao 5kg", "Coca-Cola 2L"
- price: preco em destaque. Se houver "PAGUE APENAS" ou "CLIENTE", use o menor.
- original: preco riscado anterior, ou "".
- category: Carnes|Aves|Peixes|Frios|Laticinios|Padaria|Graos|Hortifruti|Bebidas|Cervejas|Higiene|Limpeza|Congelados|Mercearia|Outros
- promo: "Leve 3 Pague 2" ou similar, ou "".
JSON COMPACTO em UMA LINHA sem markdown:
{"items":[{"name":"...","price":"R$ X,XX","original":"","category":"...","promo":""}]}
Se nao houver produtos: {"items":[]}`;
}

// ── PASS 2: Batch locate product photos ───────────────────────────────────────
async function batchLocateBboxes(apiKey, mimeType, base64, names) {
  if (!names.length) return {};
  // Split into batches of 8 to keep response short
  const BATCH = 8;
  const result = {};
  for (let start = 0; start < names.length; start += BATCH) {
    const batch    = names.slice(start, start + BATCH);
    const nameList = batch.map((n, i) => `${i+1}. ${n}`).join("\n");
    console.log(`  [batch-locate] ${start+1}-${start+batch.length} de ${names.length}...`);
    try {
      const raw = await callGroq(apiKey, VISION_MODELS[0], mimeType, base64,
        `In this supermarket flyer image, find the PHOTO (not the price tag) of each product below.
For each, reply with its number and 4 coordinates: INDEX:x1,y1,x2,y2 (proportional 0.0-1.0, top-left to bottom-right of the product photo).
One per line. Skip products not found.

Products:
${nameList}

Example reply:
1:0.05,0.20,0.30,0.55
2:0.35,0.20,0.65,0.55`, 600);

      for (const line of raw.split("\n")) {
        const m = line.match(/(\d+)\s*[:\-]\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
        if (m) {
          const idx = parseInt(m[1]) - 1;
          if (idx >= 0 && idx < batch.length) {
            const bbox = [parseFloat(m[2]),parseFloat(m[3]),parseFloat(m[4]),parseFloat(m[5])];
            if ((bbox[2]-bbox[0]) >= 0.04 && (bbox[3]-bbox[1]) >= 0.04) {
              result[batch[idx]] = bbox;
            }
          }
        }
      }
      console.log(`  [batch-locate] encontrados: ${Object.keys(result).length} total`);
    } catch(err) {
      console.warn(`  [batch-locate] erro: ${err.message}`);
    }
    if (start + BATCH < names.length) await new Promise(r => setTimeout(r, 1000));
  }
  return result;
}

// ── Fallback: individual locate ───────────────────────────────────────────────
async function locateProductBbox(apiKey, mimeType, base64, productName) {
  try {
    console.log(`  [locate] "${productName}"...`);
    const raw = await callGroq(apiKey, VISION_MODELS[0], mimeType, base64,
      `Find the product "${productName}" in this supermarket flyer.
Reply with ONLY 4 decimal numbers separated by commas (x1,y1,x2,y2) of the product PHOTO (0.0-1.0).
Example: 0.05,0.30,0.45,0.65
If not found: 0,0,0,0`, 60);
    console.log(`  [locate] raw: "${raw}"`);
    const nums = raw.match(/[0-9]*\.?[0-9]+/g);
    if (!nums || nums.length < 4) return null;
    const bbox = nums.slice(0,4).map(Number).map((v,i) => Math.min(1, Math.max(0, v)));
    if (bbox[0]===0 && bbox[1]===0 && bbox[2]===0 && bbox[3]===0) return null;
    if ((bbox[2]-bbox[0]) < 0.04 || (bbox[3]-bbox[1]) < 0.04) return null;
    console.log(`  [locate] ✅ [${bbox.join(",")}]`);
    return bbox;
  } catch(err) {
    console.warn(`  [locate] erro: ${err.message}`);
    return null;
  }
}

// ── Extract items from raw JSON response ──────────────────────────────────────
function decodeUnicode(str) {
  if (!str) return str;
  return str
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\u0000/g, '');
}

function normalizeKey(name) {
  return decodeUnicode(name || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .substring(0, 30);
}

function extractItems(raw, tileIdx) {
  if (!raw) return [];
  console.log(`[tile ${tileIdx}] Resposta (${raw.length} chars): ${raw.substring(0,150)}`);

  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s === -1 || e === -1) return [];

  // Aggressive pre-clean: remove any " that appears right after a digit before , ] or }
  const cleaned = raw.substring(s, e+1)
    .replace(/(\d+\.?\d*)"(\s*[,\]\}])/g, '$1$2');

  try {
    const items = JSON.parse(cleaned).items || [];
    const result = items.filter(i => i.name && i.price).map(i => ({
      ...i,
      name: decodeUnicode(i.name || "")
        .replace(/marca\s*\+?\s*produto\s*\+?\s*quantidade/gi, "")
        .replace(/\s*\+\s*(marca|produto|quantidade)\s*/gi, "")
        .trim(),
    })).filter(i => i.name.length > 2);
    console.log(`[tile ${tileIdx}] ✅ ${result.length} produtos`);
    return result;
  } catch(_) {
    // Re-clean and retry
    const reClean = cleaned.replace(/,\s*"[a-z_]+"\s*:\s*(?=[,\}])/gi, '');
    try {
      const items = JSON.parse(reClean).items || [];
      console.log(`[tile ${tileIdx}] ✅ ${items.length} produtos (re-parse)`);
      return items.filter(i => i.name && i.price).map(i => ({ ...i, name: decodeUnicode(i.name).trim() }));
    } catch(_) {}

    // Last resort: regex per field
    const names  = [...raw.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
    const prices = [...raw.matchAll(/"price"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
    const cats   = [...raw.matchAll(/"category"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
    const len    = Math.min(names.length, prices.length);
    const items  = [];
    for (let i = 0; i < len; i++) {
      items.push({ name: decodeUnicode(names[i]).trim(), price: prices[i], original: "", category: cats[i] || "Mercearia", promo: "" });
    }
    console.log(`[tile ${tileIdx}] Recuperação regex: ${items.length} produtos`);
    return items;
  }
}

function dedup(items) {
  const seen = new Map(); const result = [];
  for (const item of items) {
    const key = normalizeKey(item.name);
    if (!seen.has(key)) { seen.set(key, result.length); result.push(item); }
    else {
      const i = seen.get(key);
      if (item.promo && !result[i].promo) result[i].promo = item.promo;
      if (item.image && !result[i].image) result[i].image = item.image;
    }
  }
  return result;
}

// ── Main tile analysis: two-pass ──────────────────────────────────────────────
async function analyzeTile(tile, mimeType, apiKey) {
  console.log(`[tile ${tile.index+1}/${tile.total}] Iniciando... (${tile.width}x${tile.height}px)`);

  // PASS 1: Extract product list (no bbox)
  let raw = "";
  for (const model of VISION_MODELS) {
    try {
      console.log(`[tile ${tile.index+1}] Tentando: ${model}`);
      raw = await callGroq(apiKey, model, mimeType, tile.base64, buildExtractPrompt(tile.index, tile.total));
      console.log(`[tile ${tile.index+1}] OK: ${model}`);
      break;
    } catch(err) {
      console.warn(`[tile ${tile.index+1}] Falhou (${model}): ${err.message}`);
      await new Promise(r => setTimeout(r, 600));
    }
  }
  if (!raw) { console.error(`[tile ${tile.index+1}] Todos os modelos falharam`); return []; }

  const items = extractItems(raw, tile.index + 1);
  if (!items.length) return [];

  // PASS 2: Batch locate product photos
  const names   = items.map(i => i.name);
  const bboxMap = await batchLocateBboxes(apiKey, mimeType, tile.base64, names);

  // Individual fallback for missing — sequential to avoid rate limit
  const missing = names.filter(n => !bboxMap[n]);
  if (missing.length > 0) {
    console.log(`  Fallback individual: ${missing.length} produtos`);
    for (const name of missing) {
      const bbox = await locateProductBbox(apiKey, mimeType, tile.base64, name);
      if (bbox) bboxMap[name] = bbox;
      await new Promise(r => setTimeout(r, 300)); // small gap between calls
    }
  }

  // Crop images
  return Promise.all(items.map(async item => {
    const bbox  = bboxMap[item.name] || null;
    let   image = null;
    if (bbox) {
      image = await cropProductImage(tile.buffer, tile.width, tile.height, bbox);
      console.log(`  ${item.name}: ${image ? "✅" : "❌ crop falhou"}`);
    } else {
      console.warn(`  ${item.name}: sem bbox`);
    }
    return { ...item, image };
  }));
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
    const store = await db.one("INSERT INTO stores (name,color) VALUES ($1,$2) RETURNING *", [name.trim(), color||"#1f7a4a"]);
    res.json(store);
  } catch (err) {
    if (err.code==="23505") return res.status(409).json({ error: "Mercado já cadastrado." });
    res.status(500).json({ error: err.message });
  }
});
app.delete("/api/stores/:id", async (req, res) => {
  try { await db.run("DELETE FROM stores WHERE id=$1",[req.params.id]); res.json({ok:true}); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch("/api/stores/:id", async (req, res) => {
  try {
    const { name, color } = req.body;
    res.json(await db.one("UPDATE stores SET name=$1,color=$2 WHERE id=$3 RETURNING *",[name.trim(),color,req.params.id]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/markets", async (req, res) => {
  try {
    const markets = await db.all("SELECT * FROM markets ORDER BY created_at DESC");
    res.json(await Promise.all(markets.map(async m => ({
      id:m.id, market:m.market, color:m.color, date:m.date, date_end:m.date_end||null, tiles:m.tiles,
      items:(await db.all("SELECT * FROM items WHERE market_id=$1",[m.id])).map(i=>({...i,fav:Boolean(i.fav)})),
    }))));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) return res.status(401).json({ error: "Chave de API ausente." });
    if (!req.file) return res.status(400).json({ error: "Nenhuma imagem enviada." });
    const typeMap  = {"image/jpeg":"image/jpeg","image/jpg":"image/jpeg","image/png":"image/png","image/webp":"image/webp"};
    const mimeType = typeMap[req.file.mimetype] || "image/jpeg";
    const market   = req.body.market    || "Mercado";
    const color    = req.body.color     || "#1f7a4a";
    const dateEnd  = req.body.date_end  || null;
    const date     = req.body.date_start || new Date().toLocaleDateString("pt-BR");
    const tiles    = await splitImageToTiles(req.file.buffer);
    const allItems = [];
    for (let i = 0; i < tiles.length; i++) {
      const result = await analyzeTile(tiles[i], mimeType, apiKey);
      allItems.push(...result);
      // Pause between tiles to stay within 30k TPM rate limit
      if (i + 1 < tiles.length) await new Promise(r => setTimeout(r, 1500));
    }
    const items  = dedup(allItems);
    const mktRow = await db.one("INSERT INTO markets (market,color,date,date_end,tiles) VALUES ($1,$2,$3,$4,$5) RETURNING *",[market,color,date,dateEnd,tiles.length]);
    for (const item of items) {
      await db.run("INSERT INTO items (market_id,name,price,original,category,promo,image) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [mktRow.id,item.name,item.price,item.original||"",item.category||"Outros",item.promo||"",item.image||null]);
    }
    res.json({ id:mktRow.id, market, color, date, date_end:dateEnd, tiles:tiles.length, items:items.map(i=>({...i,fav:false})) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/items/:id/fav", async (req, res) => {
  try { await db.run("UPDATE items SET fav=$1 WHERE id=$2",[req.body.fav,req.params.id]); res.json({ok:true}); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/api/items/:id", async (req, res) => {
  try { await db.run("DELETE FROM items WHERE id=$1",[req.params.id]); res.json({ok:true}); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/api/markets/:id", async (req, res) => {
  try { await db.run("DELETE FROM markets WHERE id=$1",[req.params.id]); res.json({ok:true}); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, "0.0.0.0", async () => {
    const total = await db.one("SELECT COUNT(*) as n FROM markets");
    console.log(`\n🥦 OfertaBot Web | ${process.env.DATABASE_URL ? "☁️ Render" : `🏠 http://localhost:${PORT}`} | 📦 ${total.n} folheto(s)\n`);
  });
}).catch(err => { console.error("❌ Banco:", err.message); process.exit(1); });
