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
    let [x1r, y1r, x2r, y2r] = bbox.map(v => Math.min(1, Math.max(0, Number(v) || 0)));

    console.log(`  [sharp] entrada: [${x1r.toFixed(3)},${y1r.toFixed(3)},${x2r.toFixed(3)},${y2r.toFixed(3)}] tile=${tileW}x${tileH}`);

    // Skip zero or near-zero bboxes
    if ((x2r - x1r) < 0.05 || (y2r - y1r) < 0.05) {
      console.warn(`  [sharp] bbox muito pequeno, retornando null`);
      return null;
    }

    // In Brazilian supermarket flyers the product PHOTO is always in the top ~55%
    // of the card and the PRICE is in the bottom ~45%.
    // We always crop only the top 60% of whatever bbox the model gives us —
    // this reliably captures the photo and avoids the price tag.
    const cardH = y2r - y1r;
    y2r = y1r + cardH * 0.60;   // keep only top 60% of card height

    // Add 2% padding
    const pad = 0.02;
    const px1 = Math.max(0, x1r - pad);
    const py1 = Math.max(0, y1r - pad);
    const px2 = Math.min(1, x2r + pad);
    const py2 = Math.min(1, y2r + pad);

    const left   = Math.floor(px1 * tileW);
    const top    = Math.floor(py1 * tileH);
    const width  = Math.max(20, Math.floor((px2 - px1) * tileW));
    const height = Math.max(20, Math.floor((py2 - py1) * tileH));

    const safeW = Math.min(width,  tileW - left);
    const safeH = Math.min(height, tileH - top);
    console.log(`  [sharp] extrato: left=${left} top=${top} w=${safeW} h=${safeH}`);
    if (safeW < 10 || safeH < 10) {
      console.warn(`  [sharp] área muito pequena (${safeW}x${safeH}), retornando null`);
      return null;
    }

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

function buildPrompt(index, total, row, col, cols, rows) {
  const pos = total > 1
    ? `Secao ${index+1} de ${total} de um folheto de supermercado brasileiro.`
    : "Folheto de supermercado brasileiro.";
  return `${pos}

Extraia todos os produtos com preco visivel e retorne JSON puro sem markdown.

Regras:
- name: nome real do produto com marca e quantidade. Exemplos: "Arroz Tio Joao 5kg", "Coca-Cola 2L", "Frango Inteiro Sadia 1kg"
- price: preco promocional em destaque (ex: "R$ 8,99"). Se houver "PAGUE APENAS" ou preco de clube, use esse.
- original: preco anterior riscado. Se nao visivel, use "".
- category: escolha a categoria CORRETA baseada no produto:
  Carnes (carne bovina/suina/ovina), Aves (frango/peru/pato), Peixes (peixe/frutos do mar),
  Frios (presunto/salsicha/linguica/mortadela), Laticinios (leite/queijo/iogurte/manteiga/requeijao),
  Padaria (pao/bolo/biscoito/farinha/macarrao), Graos (arroz/feijao/lentilha/grao-de-bico),
  Hortifruti (fruta/legume/verdura), Bebidas (suco/refrigerante/agua/cafe/cha),
  Cervejas (cerveja/chopp), Higiene (sabonete/shampoo/creme dental/papel higienico),
  Limpeza (detergente/amaciante/desinfetante/saco de lixo/vassoura/esponja),
  Congelados (produto congelado), Mercearia (outros alimentos), Outros (nao alimenticio)
- promo: texto de promocao se houver, como "Leve 3 Pague 2". Senao, use "".
- bbox: [x1, y1, x2, y2] coordenadas proporcionais (0.0 a 1.0) da FOTO/IMAGEM DO PRODUTO (nao do preco, nao do nome — apenas a foto do item). x1,y1 = canto superior esquerdo da foto. x2,y2 = canto inferior direito da foto. Se nao houver foto clara, use [0,0,0,0].

IMPORTANTE: retorne JSON COMPACTO em UMA UNICA LINHA, sem espacos, sem quebras de linha:
{"items":[{"name":"Arroz Tio Joao 5kg","price":"R$ 22,90","original":"R$ 29,90","category":"Graos","promo":"","bbox":[0.0,0.2,0.5,0.5]}]}

Se nao houver produtos: {"items":[]}`;
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

  // Pre-clean: remove stray quotes inside number arrays like [0.1,0.2,0.3"]
  const cleanedJson = raw.substring(start, end + 1)
    .replace(/(\d)"(\s*[,\]])/g, '$1$2')   // 0.708" , → 0.708 ,
    .replace(/(\d)"(\s*})/g,    '$1$2');   // 0.708" } → 0.708 }

  try {
    const parsed = JSON.parse(cleanedJson);
    const items  = parsed.items || [];
    // Sanitize names - decode unicode escapes and remove placeholder text
    const cleaned = items.filter(i => i.name && i.price).map(i => {
      let name = i.name;
      // Decode unicode escapes like \u00e3 → ã
      name = name.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      name = name.replace(/\u([0-9a-fA-F]{4})/g,   (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      // Remove placeholder text the model sometimes copies literally
      name = name
        .replace(/marca\s*\+?\s*produto\s*\+?\s*quantidade/gi, '')
        .replace(/\s*\+\s*(marca|produto|quantidade)\s*/gi, '')
        .replace(/^[\s\-\+]+|[\s\-\+]+$/g, '')
        .trim();
      return { ...i, name };
    }).filter(i => i.name.length > 2);
    console.log(`[tile ${tileIdx}] ✅ ${cleaned.length} produtos`);
    return cleaned;
  } catch(e) {
    console.warn(`[tile ${tileIdx}] JSON completo falhou (${e.message}), tentando recuperar itens completos...`);
    // Pre-clean stray quotes in bbox arrays, then retry full parse
    const reClean = raw
      .replace(/(\d)"(\s*[,\]])/g, '$1$2')
      .replace(/(\d)"(\s*})/g,    '$1$2');
    const rStart = reClean.indexOf("{"), rEnd = reClean.lastIndexOf("}");
    if (rStart !== -1 && rEnd !== -1) {
      try {
        const parsed2 = JSON.parse(reClean.substring(rStart, rEnd + 1));
        const items2  = (parsed2.items || []);
        if (items2.length > 0) {
          const cleaned2 = items2.filter(i => i.name && i.price).map(i => ({
            ...i,
            name:  decodeUnicode(i.name || "").trim(),
            bbox:  Array.isArray(i.bbox) && i.bbox.length === 4 ? i.bbox : null,
          }));
          console.log(`[tile ${tileIdx}] Re-parse após limpeza: ${cleaned2.length} produtos`);
          return cleaned2;
        }
      } catch(_) {}
    }

    // Last resort: extract only name+price via regex — bbox will be null → locateProductBbox will run
    const items = [];
    const nameRe = /"name"\s*:\s*"([^"]+)"/g;
    const priceRe = /"price"\s*:\s*"([^"]+)"/g;
    const catRe   = /"category"\s*:\s*"([^"]+)"/g;
    const names   = [...raw.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
    const prices  = [...raw.matchAll(/"price"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
    const cats    = [...raw.matchAll(/"category"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
    const len     = Math.min(names.length, prices.length);
    for (let i = 0; i < len; i++) {
      items.push({
        name:     decodeUnicode(names[i] || "").trim(),
        price:    prices[i] || "",
        original: "",
        category: cats[i] || "Mercearia",
        promo:    "",
        bbox:     null,  // null = no bbox → locateProductBbox will find it
      });
    }
    console.log(`[tile ${tileIdx}] Recuperação: ${items.length} produtos (bbox=null → locate será chamado)`);
    return items;
  }
}


// ── Localiza um produto específico na imagem quando bbox está ausente ──────────
async function locateProductBbox(apiKey, mimeType, base64, productName) {
  try {
    console.log(`  [locate] Buscando bbox de "${productName}"...`);
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        max_tokens: 100,
        temperature: 0,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
            { type: "text", text: `Nesta imagem de folheto de supermercado, encontre o produto: "${productName}".
Retorne APENAS um JSON com as coordenadas proporcionais (0.0 a 1.0) da FOTO do produto (nao do preco):
{"bbox":[x1,y1,x2,y2]}
Se nao encontrar: {"bbox":[0,0,0,0]}` }
          ]
        }]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw  = (data.choices?.[0]?.message?.content || "").trim();
    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s === -1 || e === -1) return null;
    // Pre-clean stray quotes inside number arrays: 0.708" → 0.708
    const cleanRaw = raw.substring(s, e + 1)
      .replace(/(\d)"(\s*[,\]])/g, '$1$2')
      .replace(/(\d)"(\s*})/g,     '$1$2');
    const parsed = JSON.parse(cleanRaw);
    const bbox = parsed.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4) return null;
    const [x1, y1, x2, y2] = bbox.map(Number);
    if ((x2 - x1) < 0.05 || (y2 - y1) < 0.05) return null;
    console.log(`  [locate] ✅ bbox encontrado: [${bbox.join(",")}]`);
    return bbox;
  } catch(err) {
    console.warn(`  [locate] falhou: ${err.message}`);
    return null;
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

  // Crop images for each item — with fallback bbox locate
  return Promise.all(items.map(async item => {
    let image = null;
    let bbox  = Array.isArray(item.bbox) && item.bbox.length === 4 ? item.bbox : null;
    console.log(`  [crop] "${item.name}" bbox=${JSON.stringify(bbox)}`);

    // If bbox is missing or zero, ask Groq to locate this specific product
    if (!bbox || (bbox[2] - bbox[0]) < 0.05 || (bbox[3] - bbox[1]) < 0.05) {
      bbox = await locateProductBbox(apiKey, mimeType, tile.base64, item.name);
    }

    if (bbox) {
      const [x1, y1, x2, y2] = bbox.map(Number);
      const w = x2 - x1, h = y2 - y1;
      console.log(`  [crop] w=${w.toFixed(3)} h=${h.toFixed(3)} tile=${tile.width}x${tile.height}`);
      if (w > 0.02 && h > 0.02) {
        image = await cropProductImage(tile.buffer, tile.width, tile.height, bbox);
        console.log(`  [crop] resultado: ${image ? "✅ (" + image.length + " chars)" : "❌ null"}`);
      }
    } else {
      console.warn(`  [crop] sem bbox para "${item.name}", sem imagem`);
    }
    return { ...item, image };
  }));
}

function decodeUnicode(str) {
  if (!str) return str;
  return str
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\u([0-9a-fA-F]{4})/g,   (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function normalizeKey(name) {
  return decodeUnicode(name)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-z0-9]/g, "")
    .substring(0, 30);
}

function dedup(items) {
  const seen = new Map(); const result = [];
  for (const item of items) {
    // Decode unicode in name before dedup
    const decodedName = decodeUnicode(item.name || "").trim();
    const key = normalizeKey(decodedName);
    if (!seen.has(key)) {
      seen.set(key, result.length);
      result.push({ ...item, name: decodedName });
    } else {
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
