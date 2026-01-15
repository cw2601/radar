// api/pps.js (Vercel Serverless Function)

export default async function handler(req, res) {
  // --- CORS + Preflight 처리
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

    // --- 파라미터 구성
    const params = new URLSearchParams({
      serviceKey,
      type: "json",
      pageNo: String(req.query.pageNo || "1"),
      numOfRows: String(req.query.numOfRows || "100"), // 더 많은 데이터를 가져와서 필터링
    });

    if (kind === "bid") {
      params.set("bidNtceBgnDt", `${fromYmd}0000`);
      params.set("bidNtceEndDt", `${toYmd}2359`);
    } else if (kind === "award") {
      params.set("opengBgnDt", `${fromYmd}0000`);
      params.set("opengEndDt", `${toYmd}2359`);
      params.set("bsnsDivCd", String(req.query.bsnsDivCd || "5"));
    } else if (kind === "contract") {
      params.set("cntrctCnclsBgnDate", `${fromYmd}`);
      params.set("cntrctCnclsEndDate", `${toYmd}`);
    }

    const url = `${endpoint}?${params.toString()}`;

    // --- fetch 실행
    const { ok, status, text } = await fetchTextWithTimeout(url, 15000);

    if (!ok) {
      return res.status(502).json({
        error: `Upstream Error: ${status}`,
        sourceUrl: url,
      });
    }

    // --- JSON Parse 및 데이터 추출
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "Non-JSON response from API",
        detail: text.slice(0, 500),
      });
    }

    const { items, total, matched } = extractItems(json, kind, q);

    // Vercel Edge Cache (10분)
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");

    return res.status(200).json({
      kind,
      q,
      meta: {
        totalCount: total,
        matchedCount: matched,
        count: items.length,
      },
      items,
      range: `${fromYmd} ~ ${toYmd}`,
      fetchedAt: new Date().toISOString(),
    });

  } catch (e) {
    return res.status(500).json({
      error: "Internal Server Error",
      message: String(e.message),
    });
  }
}

// ---------------- Helpers ----------------

function normalizeKind(v) {
  const k = String(v || "bid").toLowerCase().trim();
  return ["bid", "award", "contract"].includes(k) ? k : "bid";
}

function normalizeServiceKey(key) {
  const s = String(key || "").trim();
  return s.includes("%") ? s : encodeURIComponent(s);
}

function getNowKstDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function fmtYmd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

async function fetchTextWithTimeout(url, ms = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { 
      signal: controller.signal,
      headers: { "Accept": "application/json" }
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 599, text: String(e) };
  } finally {
    clearTimeout(t);
  }
}

// ---------------- Data Extraction Logic ----------------

function extractItems(raw, kind, q) {
  // sourceURL 구조: response.body.items 가 바로 배열임
  let list = raw?.response?.body?.items ?? [];
  // 간혹 응답 구조가 다른 경우(item 필드 밑에 배열이 있는 경우) 대응
  if (!Array.isArray(list) && list?.item) {
    list = list.item;
  }
  const arr = Array.isArray(list) ? list : [list].filter(Boolean);

  const qlc = String(q || "").toLowerCase().trim();
  const hasQ = (target) => String(target || "").toLowerCase().includes(qlc);

  const mapped = arr.map((x) => {
    if (kind === "bid") {
      return {
        title: x.bidNtceNm || "제목 없음",
        date: x.bidNtceDate || x.bidNtceDt || "",
        time: x.bidNtceBgn || "",
        org: x.ntceInsttNm || x.dmndInsttNm || "",
        amount: formatAmount(x.asignBdgtAmt || x.presmptPrce),
        status: x.bidNtceSttusNm || "일반",
        _idA: x.bidNtceNo,
        _idB: x.bidNtceOrd,
      };
    }
    if (kind === "award") {
      return {
        title: x.bidNtceNm || x.bidNm || "제목 없음",
        date: x.opengDate || x.opengDt || "",
        org: x.ntceInsttNm || x.dmndInsttNm || "",
        amount: formatAmount(x.scsbidAmt || x.cntrctAmt),
        winner: x.prtcptnEntrpsNm || x.sucsfnEntrpsNm || "결과 확인중",
      };
    }
    // contract
    return {
      title: x.cntrctNm || x.bidNtceNm || "제목 없음",
      date: x.cntrctCnclsDate || "",
      org: x.ntceInsttNm || x.cntrctInsttNm || x.dminsttNm || "",
      amount: formatAmount(x.cntrctAmt || x.contAmt),
      period: x.cntrctPrd || "",
    };
  });

  // 검색어가 있을 경우 필터링
  const filtered = qlc 
    ? mapped.filter(it => hasQ(it.title) || hasQ(it.org)) 
    : mapped;

  // 나라장터 링크 생성
  const withUrl = filtered.map(it => {
    let url = `https://www.g2b.go.kr:8101/ep/tbid/tbidList.do?bidNm=${encodeURIComponent(it.title)}`;
    
    if (kind === "bid" && it._idA) {
      const bidno = String(it._idA);
      const bidseq = String(it._idB || "00").padStart(2, "0");
      // 물품(5), 공사(3), 용역(1) 등 구분이 필요하나 기본적으로 물품/용역 상세페이지 연결
      url = `https://www.g2b.go.kr:8081/ep/invitation/publish/bidInfoDtl.do?bidno=${bidno}&bidseq=${bidseq}&releaseYn=Y&taskClCd=5`;
    }
    
    return { ...it, url };
  });

  return {
    items: withUrl.slice(0, 50), // 최종 결과 50개 제한
    total: arr.length,
    matched: filtered.length
  };
}

function formatAmount(v) {
  const n = parseInt(String(v || "0").replace(/[^0-9]/g, ""), 10);
  if (isNaN(n) || n === 0) return "0";
  return n.toLocaleString("ko-KR");
}
