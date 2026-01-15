// api/pps.js (Vercel Serverless Function)

export default async function handler(req, res) {
  // --- CORS + Preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kind = normalizeKind(req.query.kind);
    const qRaw = String(req.query.q ?? "").trim();
    const q = qRaw.slice(0, 60);

    const serviceKeyRaw = process.env.DATA_GO_KR_SERVICE_KEY;
    if (!serviceKeyRaw) {
      return res.status(500).json({ error: "Missing DATA_GO_KR_SERVICE_KEY" });
    }
    const serviceKey = normalizeServiceKey(serviceKeyRaw);

    const base = "https://apis.data.go.kr/1230000/ao/PubDataOpnStdService";
    const endpointByKind = {
      bid: `${base}/getDataSetOpnStdBidPblancInfo`,
      award: `${base}/getDataSetOpnStdScsbidInfo`,
      contract: `${base}/getDataSetOpnStdCntrctInfo`,
    };

    const endpoint = endpointByKind[kind];
    if (!endpoint) {
      return res.status(400).json({ error: "Invalid kind. Use bid|award|contract" });
    }

    // --- KST 기준 날짜 범위 계산
    const nowKst = getNowKstDate();
    const daysBack = kind === "award" ? 6 : 29;
    const fromKst = new Date(nowKst.getTime() - daysBack * 24 * 60 * 60 * 1000);

    const fromYmd = fmtYmd(fromKst);
    const toYmd = fmtYmd(nowKst);

    // --- kind별 파라미터 구성
    const params = new URLSearchParams({
      serviceKey,
      type: "json",
      pageNo: String(req.query.pageNo || "1"),
      numOfRows: String(req.query.numOfRows || "100"),
    });

    if (kind === "bid") {
      params.set("bidNtceBgnDt", `${fromYmd}0000`);
      params.set("bidNtceEndDt", `${toYmd}2359`);
    }

    if (kind === "award") {
      params.set("opengBgnDt", `${fromYmd}0000`);
      params.set("opengEndDt", `${toYmd}2359`);
      const bsnsDivCd = String(req.query.bsnsDivCd || "5");
      params.set("bsnsDivCd", bsnsDivCd);
    }

    if (kind === "contract") {
      params.set("cntrctCnclsBgnDate", `${fromYmd}`);
      params.set("cntrctCnclsEndDate", `${toYmd}`);
    }

    const url = `${endpoint}?${params.toString()}`;

    // --- fetch (timeout)
    const { ok, status, text } = await fetchTextWithTimeout(url, 12000);

    if (!ok) {
      return res.status(502).json({
        error: `Upstream ${status}`,
        detail: (text || "").slice(0, 1200),
        sourceUrl: url,
      });
    }

    // --- 안전 JSON parse
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "Upstream returned non-JSON (serviceKey encoding or params issue)",
        detail: (text || "").slice(0, 1200),
        sourceUrl: url,
      });
    }

    // --- items 추출/필터/URL 생성
    const { items, total, matched } = extractItems(json, kind, q);

    // Vercel edge cache (10분)
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");

    return res.status(200).json({
      kind,
      q,
      meta: {
        totalFromApi: total,
        matchedAfterFilter: matched,
        returned: items.length,
      },
      items,
      sourceUrl: url,
      fetchedAt: new Date().toISOString(),
      kstRange: `${fromYmd.slice(0, 4)}-${fromYmd.slice(4, 6)}-${fromYmd.slice(6, 8)} ~ ${toYmd.slice(
        0,
        4
      )}-${toYmd.slice(4, 6)}-${toYmd.slice(6, 8)}`,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Proxy failed",
      message: String(e?.message || e),
    });
  }
}

// ---------------- helpers ----------------

function normalizeKind(v) {
  const k = String(v || "bid").toLowerCase().trim();
  if (k === "bid" || k === "award" || k === "contract") return k;
  return "bid";
}

function normalizeServiceKey(key) {
  const s = String(key || "").trim();
  if (!s) return s;
  return s.includes("%") ? s : encodeURIComponent(s);
}

function getNowKstDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtYmd(d) {
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  return `${y}${m}${day}`;
}

async function fetchTextWithTimeout(url, ms = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);

  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/plain,*/*",
      },
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return {
      ok: false,
      status: 599,
      text: `Fetch failed: ${String(e?.message || e)}`,
    };
  } finally {
    clearTimeout(t);
  }
}

// ---------------- core: extract + filter + url ----------------

function extractItems(raw, kind, q) {
  // 실제 API 응답 구조: response.body.items (배열)
  const list = raw?.response?.body?.items ?? [];
  const arr = Array.isArray(list) ? list : [list].filter(Boolean);

  const qlc = String(q || "").toLowerCase().trim();
  
  // 검색어로 필터링
  const hasQ = (s) => {
    if (!qlc) return true;
    const str = String(s || "").toLowerCase();
    return str.includes(qlc);
  };

  const mapped = arr.map((x) => {
    if (kind === "bid") {
      const title = x?.bidNtceNm || "Untitled";
      const bidNo = x?.bidNtceNo || "";
      const bidOrd = x?.bidNtceOrd || "";
      const date = x?.bidNtceDate || "";
      const time = x?.bidNtceBgn || "";
      
      return {
        title,
        date: date,
        time: time,
        org: x?.ntceInsttNm || x?.dmndInsttNm || "",
        amount: x?.asignBdgtAmt ?? x?.presmptPrce ?? "",
        status: x?.bidNtceSttusNm || "",
        _idA: bidNo,
        _idB: bidOrd,
      };
    }

    if (kind === "award") {
      const title = x?.bidNtceNm || "Untitled";
      const date = x?.opengDate || "";
      const time = x?.opengTm || "";
      
      return {
        title,
        date: date,
        time: time,
        org: x?.ntceInsttNm || x?.dmndInsttNm || "",
        amount: x?.scsbidAmt ?? x?.cntrctAmt ?? "",
        winner: x?.prtcptnEntrpsNm || x?.sucsfnEntrpsNm || "",
        status: x?.bidNtceSttusNm || "",
      };
    }

    // contract
    const title = x?.cntrctNm || x?.bidNtceNm || "Untitled";
    const date = x?.cntrctCnclsDate || x?.cntrctDate || "";
    
    return {
      title,
      date: date,
      org: x?.dmndInsttNm || x?.cntrctInsttNm || x?.ntceInsttNm || "",
      amount: x?.cntrctAmt ?? x?.contAmt ?? "",
      period: x?.cntrctPrd || x?.cntrctPeriod || "",
      status: x?.cntrctCnclsSttusNm || "",
    };
  });

  // 필터링: 제목 또는 기관명에 검색어 포함
  const filtered = mapped.filter((it) => hasQ(it.title) || hasQ(it.org));

  const mkSearchUrl = (keyword) =>
    `https://www.g2b.go.kr:8101/ep/tbid/tbidList.do?bidNm=${encodeURIComponent(keyword || "")}`;

  // URL 생성 및 금액 포맷팅
  const withUrl = filtered.map((it) => {
    // 금액 포맷팅
    const amountStr = prettifyAmount(it.amount);
    
    let url = "";
    if (kind === "bid" && it._idA) {
      const bidno = String(it._idA);
      const bidseq = String(it._idB || "00").padStart(2, "0");
      url = `https://www.g2b.go.kr:8081/ep/invitation/publish/bidInfoDtl.do` +
            `?bidno=${encodeURIComponent(bidno)}&bidseq=${encodeURIComponent(bidseq)}` +
            `&releaseYn=Y&taskClCd=5`;
    } else {
      url = mkSearchUrl(it.title);
    }
    
    return {
      title: it.title,
      date: it.date,
      time: it.time,
      org: it.org,
      amount: amountStr,
      status: it.status,
      winner: it.winner,
      period: it.period,
      url: url,
      fallbackUrl: mkSearchUrl(it.title)
    };
  });

  return {
    items: withUrl,
    total: arr.length,
    matched: filtered.length,
  };
}

function prettifyAmount(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const num = Number(String(s).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(num) || num === 0) return "";
  const intLike = Math.round(num);
  return intLike.toLocaleString("en-US");
}
