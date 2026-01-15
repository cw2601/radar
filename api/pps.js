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

    // filter=0이면 서버에서 q 필터링 OFF (원본 전체 확인용)
    const filterEnabled = String(req.query.filter ?? "1") !== "0";

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

    // --- KST 기준 날짜 범위 계산 (API 제한 반영)
    const nowKst = getNowKstDate();
    const daysBack = kind === "award" ? 6 : 29; // award=1주일, bid/contract=1개월
    const fromKst = new Date(nowKst.getTime() - daysBack * 24 * 60 * 60 * 1000);

    const fromYmd = fmtYmd(fromKst);
    const toYmd = fmtYmd(nowKst);

    // --- 요청 numOfRows/pageNo
    const numOfRows = clampInt(req.query.numOfRows, 100, 1, 1000); // 기본 100, 최대 1000
    const pageNo = clampInt(req.query.pageNo, 1, 1, 9999);

    // ✅ 기본은 3페이지까지 자동 합치기 (너무 많이 긁으면 느려져서 일단 3)
    const maxPages = clampInt(req.query.maxPages, 3, 1, 10);

    // award는 bsnsDivCd 없으면 5(용역)로
    const bsnsDivCd = String(req.query.bsnsDivCd || "5");

    // --- kind별 베이스 파라미터 구성
    const baseParams = new URLSearchParams({
      serviceKey,
      type: "json",
      numOfRows: String(numOfRows),
    });

    if (kind === "bid") {
      // bidNtceBgnDt / bidNtceEndDt : YYYYMMDDHHMM (1개월 제한)
      baseParams.set("bidNtceBgnDt", `${fromYmd}0000`);
      baseParams.set("bidNtceEndDt", `${toYmd}2359`);
    }

    if (kind === "award") {
      // opengBgnDt / opengEndDt : YYYYMMDDHHMM (1주일 제한)
      baseParams.set("opengBgnDt", `${fromYmd}0000`);
      baseParams.set("opengEndDt", `${toYmd}2359`);
      baseParams.set("bsnsDivCd", bsnsDivCd);
    }

    if (kind === "contract") {
      // cntrctCnclsBgnDate / cntrctCnclsEndDate : YYYYMMDD (1개월 제한)
      baseParams.set("cntrctCnclsBgnDate", `${fromYmd}`);
      baseParams.set("cntrctCnclsEndDate", `${toYmd}`);
    }

    // ---------------------------
    // ✅ 1) 첫 페이지 먼저 호출해서 totalCount 확인
    // ---------------------------
    const firstUrl = buildUrl(endpoint, baseParams, pageNo);
    const first = await fetchJsonUpstream(firstUrl);

    // totalCount는 응답에 보통 있음
    const totalCount = toInt(first?.json?.response?.body?.totalCount, 0);

    // ---------------------------
    // ✅ 2) 필요한 만큼 추가 페이지 호출 (기본 3페이지)
    //    - totalCount가 크면 2~3페이지 합치는 것만으로도 “너무 적다” 느낌이 크게 줄어듦
    // ---------------------------
    const pagesToFetch = decidePagesToFetch({
      totalCount,
      numOfRows,
      pageNo,
      maxPages,
    });

    const results = [first];
    for (let i = 2; i <= pagesToFetch; i++) {
      const p = pageNo + (i - 1);
      const url = buildUrl(endpoint, baseParams, p);
      const r = await fetchJsonUpstream(url);
      results.push(r);
    }

    // ---------------------------
    // ✅ 3) 여러 페이지 items 합치기
    // ---------------------------
    const mergedRaw = mergeResponses(results.map(r => r.json));

    // items 추출/필터/URL 생성
    const { items, totalItemsParsed, matchedAfterFilter } = extractItems(mergedRaw, kind, q, {
      filterEnabled,
      limit: 50, // 프론트 표시용 반환 제한 (원하면 조절)
    });

    // Vercel edge cache (10분)
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");

    return res.status(200).json({
      kind,
      q,
      meta: {
        totalCountFromApi: totalCount,          // ✅ 진짜 전체 개수
        pagesFetched: pagesToFetch,             // ✅ 우리가 몇 페이지 긁었는지
        numOfRows,
        pageNoStart: pageNo,
        totalItemsParsed,                       // ✅ 실제로 파싱된 항목 수(합친 결과)
        matchedAfterFilter: matchedAfterFilter, // ✅ q 필터 후
        returned: items.length,                 // ✅ 최종 반환(보통 50으로 제한)
        filterEnabled,
        kstRange: `${fromYmd.slice(0, 4)}-${fromYmd.slice(4, 6)}-${fromYmd.slice(6, 8)} ~ ${toYmd.slice(0, 4)}-${toYmd.slice(4, 6)}-${toYmd.slice(6, 8)}`,
      },
      items,
      sourceUrl: firstUrl,
      fetchedAt: new Date().toISOString(),
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
  // 이미 % 인코딩 되어 있으면 그대로, 아니면 encode
  return s.includes("%") ? s : encodeURIComponent(s);
}

function getNowKstDate() {
  // Vercel은 UTC 기반이라 KST로 보정
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

function clampInt(v, def, min, max) {
  const n = Number(v);
  const x = Number.isFinite(n) ? Math.floor(n) : def;
  return Math.min(max, Math.max(min, x));
}

function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

function buildUrl(endpoint, baseParams, pageNo) {
  const params = new URLSearchParams(baseParams);
  params.set("pageNo", String(pageNo));
  return `${endpoint}?${params.toString()}`;
}

function decidePagesToFetch({ totalCount, numOfRows, pageNo, maxPages }) {
  // totalCount가 없으면 그냥 maxPages
  if (!totalCount || totalCount <= 0) return maxPages;

  // totalCount 기준으로 “필요 페이지” 계산
  const totalPages = Math.ceil(totalCount / numOfRows);

  // 시작 페이지(pageNo)부터 maxPages만큼, 총페이지를 넘기지 않게
  const remain = totalPages - (pageNo - 1);
  return Math.max(1, Math.min(maxPages, remain));
}

// fetch + timeout + safe json
async function fetchJsonUpstream(url, timeoutMs = 12000) {
  const { ok, status, text } = await fetchTextWithTimeout(url, timeoutMs);

  if (!ok) {
    throw new Error(`Upstream ${status}: ${(text || "").slice(0, 200)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // data.go.kr이 가끔 json인데도 이상하게 내려줄 때가 있어서 디버깅용
    throw new Error(`Upstream non-JSON. First bytes: ${(text || "").slice(0, 200)}`);
  }

  return { url, json };
}

async function fetchTextWithTimeout(url, ms = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);

  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json,text/plain,*/*" },
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 599, text: `Fetch failed: ${String(e?.message || e)}` };
  } finally {
    clearTimeout(t);
  }
}

// 여러 페이지 json을 하나로 합침(핵심은 items를 합치기)
function mergeResponses(jsonList) {
  const base = jsonList?.[0] || {};
  const itemsMerged = [];

  for (const raw of jsonList || []) {
    const items = pickItems(raw);
    for (const it of items) itemsMerged.push(it);
  }

  // base 구조를 유지하되 items만 우리가 합친 걸로 덮기
  // items.item 형태/배열 형태 모두 대응하기 위해 items를 배열로 둠
  const merged = deepClone(base);
  if (!merged.response) merged.response = {};
  if (!merged.response.body) merged.response.body = {};
  if (!merged.response.body.items) merged.response.body.items = {};

  // ✅ 여기서 “항목 배열”을 item에 넣어줌 (extractItems가 여기 먼저 봄)
  merged.response.body.items.item = itemsMerged;

  return merged;
}

function deepClone(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; }
}

// ✅ 실제 리스트 경로를 최대한 많이 커버
function pickItems(raw) {
  const list =
    raw?.response?.body?.items?.item ??
    raw?.response?.body?.items ??
    raw?.items?.item ??
    raw?.items ??
    [];
  const arr = Array.isArray(list) ? list : [list].filter(Boolean);

  // items가 { item:[...] } 컨테이너였던 경우를 여기서 풀어줌
  // (예: arr=[{item:[...]}] 인 경우)
  if (arr.length === 1 && arr[0] && Array.isArray(arr[0].item)) {
    return arr[0].item;
  }
  return arr;
}

// ---------------- core: extract + filter + url ----------------

function extractItems(raw, kind, q, opts = {}) {
  const filterEnabled = opts.filterEnabled !== false;
  const limit = toInt(opts.limit, 50);

  // ✅ 여기서도 items.item 우선
  const arr = pickItems(raw);

  const qlc = String(q || "").toLowerCase().trim();

  // q 필터(옵션)
  const hasQ = (s) => {
    if (!filterEnabled) return true;
    if (!qlc) return true;
    const str = String(s || "").toLowerCase();
    return str.includes(qlc);
  };

  const mapped = arr.map((x) => {
    if (kind === "bid") {
      const title = x?.bidNtceNm || x?.bidNtceName || x?.bidNm || "Untitled";
      const bidNo = x?.bidNtceNo || x?.bidNtceNum || "";
      const bidOrd = x?.bidNtceOrd || x?.bidNtceSeq || "";
      const date = x?.bidNtceDate || x?.bidNtceDt || "";
      const time = x?.bidNtceBgn || x?.bidNtceTime || "";
      return {
        title,
        date,
        time,
        org: x?.ntceInsttNm || x?.dmndInsttNm || x?.dminsttNm || "",
        amount: x?.asignBdgtAmt ?? x?.presmptPrce ?? x?.presmPrce ?? "",
        status: x?.bidNtceSttusNm || x?.bidNtceSttusName || "",
        _idA: bidNo,
        _idB: bidOrd,
      };
    }

    if (kind === "award") {
      const title = x?.bidNtceNm || x?.bidNm || x?.bidNtceName || "Untitled";
      const date = x?.opengDate || x?.opengDt || "";
      const time = x?.opengTm || "";
      return {
        title,
        date,
        time,
        org: x?.ntceInsttNm || x?.dmndInsttNm || x?.dminsttNm || "",
        amount: x?.scsbidAmt ?? x?.scsbidPrice ?? x?.cntrctAmt ?? "",
        winner: x?.prtcptnEntrpsNm || x?.sucsfnEntrpsNm || "",
        status: x?.bidNtceSttusNm || x?.bidNtceSttusName || "",
      };
    }

    // contract
    const title = x?.cntrctNm || x?.cntrctName || x?.bidNtceNm || "Untitled";
    const date = x?.cntrctCnclsDate || x?.cntrctDate || "";
    return {
      title,
      date,
      org: x?.dmndInsttNm || x?.cntrctInsttNm || x?.ntceInsttNm || x?.dminsttNm || "",
      amount: x?.cntrctAmt ?? x?.contAmt ?? "",
      period: x?.cntrctPrd || x?.cntrctPeriod || "",
      status: x?.cntrctCnclsSttusNm || "",
    };
  });

  const filtered = mapped.filter((it) => hasQ(it.title) || hasQ(it.org));

  const mkSearchUrl = (keyword) =>
    `https://www.g2b.go.kr:8101/ep/tbid/tbidList.do?bidNm=${encodeURIComponent(keyword || "")}`;

  const withUrl = filtered.slice(0, limit).map((it) => {
    const amountStr = prettifyAmount(it.amount);

    let url = "";
    if (kind === "bid" && it._idA) {
      const bidno = String(it._idA);
      const bidseq = String(it._idB || "00").padStart(2, "0");
      url =
        `https://www.g2b.go.kr:8081/ep/invitation/publish/bidInfoDtl.do` +
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
      url,
      fallbackUrl: mkSearchUrl(it.title),
    };
  });

  return {
    items: withUrl,
    totalItemsParsed: arr.length,
    matchedAfterFilter: filtered.length,
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
