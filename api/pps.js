// api/pps.js (Vercel Serverless Function)

export default async function handler(req, res) {
  // --- CORS + Preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kind = normalizeKind(req.query.kind);
    const qRaw = String(req.query.q ?? "AI").trim();
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
    const daysBack = kind === "award" ? 6 : 29; // award: 약 7일, bid/contract: 약 30일
    const fromKst = new Date(nowKst.getTime() - daysBack * 24 * 60 * 60 * 1000);

    const fromYmd = fmtYmd(fromKst);
    const toYmd = fmtYmd(nowKst);

    // --- kind별 파라미터 구성
    const params = new URLSearchParams({
      serviceKey,
      type: "json",
      pageNo: String(req.query.pageNo || "1"),
      numOfRows: String(req.query.numOfRows || "50"),
    });

    if (kind === "bid") {
      // bidNtceBgnDt / bidNtceEndDt : YYYYMMDDHHMM (1개월 제한)
      params.set("bidNtceBgnDt", `${fromYmd}0000`);
      params.set("bidNtceEndDt", `${toYmd}2359`);
    }

    if (kind === "award") {
      // opengBgnDt / opengEndDt : YYYYMMDDHHMM (1주일 제한)
      params.set("opengBgnDt", `${fromYmd}0000`);
      params.set("opengEndDt", `${toYmd}2359`);
      // bsnsDivCd: 1=물품,2=외자,3=공사,5=용역
      const bsnsDivCd = String(req.query.bsnsDivCd || "5");
      params.set("bsnsDivCd", bsnsDivCd);
    }

    if (kind === "contract") {
      // cntrctCnclsBgnDate / cntrctCnclsEndDate : YYYYMMDD (1개월 제한)
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
      kstRange:
        kind === "contract"
          ? `${fromYmd.slice(0, 4)}-${fromYmd.slice(4, 6)}-${fromYmd.slice(6, 8)} ~ ${toYmd.slice(
              0,
              4
            )}-${toYmd.slice(4, 6)}-${toYmd.slice(6, 8)}`
          : `${fromYmd.slice(0, 4)}-${fromYmd.slice(4, 6)}-${fromYmd.slice(6, 8)} ~ ${toYmd.slice(
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

// data.go.kr serviceKey는 보통 "이미 URL 인코딩된 값"을 쓰는 경우가 많아서,
// %가 포함돼 있으면 그대로, 아니면 encodeURIComponent로 안전 처리
function normalizeServiceKey(key) {
  const s = String(key || "").trim();
  if (!s) return s;
  return s.includes("%") ? s : encodeURIComponent(s);
}

function getNowKstDate() {
  // 서버는 UTC 기준이 많으니, KST로 +9h 보정한 Date를 만든 뒤
  // UTC getter로 뽑아 쓰면 "KST 달력"을 안정적으로 다룰 수 있음
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
        // data.go.kr은 특별히 필요 없지만, 일부 환경에서 안정성에 도움
        "Accept": "application/json,text/plain,*/*",
      },
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    // Abort / network error
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
  const list = raw?.response?.body?.items?.item ?? [];
  const arr = Array.isArray(list) ? list : [list].filter(Boolean);

  const qlc = String(q || "").toLowerCase().trim();
  const hasQ = (s) => String(s || "").toLowerCase().includes(qlc);

  const mapped = arr.map((x) => {
    if (kind === "bid") {
      const title = x?.bidNtceNm || x?.bidNtceName || x?.bidNm || "Untitled";
      const bidNo = x?.bidNtceNo || x?.bidNtceNum || "";
      const bidOrd = x?.bidNtceOrd || x?.bidNtceSeq || "";
      return {
        title,
        date: [x?.bidNtceDt, x?.bidNtceDate, x?.bidNtceTime].filter(Boolean).join(" "),
        org: x?.ntceInsttNm || x?.dminsttNm || x?.ntceInsttName || "",
        amount: prettifyAmount(x?.asignBdgtAmt ?? x?.presmPrce ?? ""),
        _idA: bidNo,
        _idB: bidOrd,
      };
    }

    if (kind === "award") {
      const title = x?.bidNtceNm || x?.bidNm || x?.bidNtceName || "Untitled";
      return {
        title,
        date: x?.opengDt || x?.opengDate || "",
        org: x?.ntceInsttNm || x?.dminsttNm || x?.ntceInsttName || "",
        amount: prettifyAmount(x?.scsbidAmt ?? x?.scsbidPrice ?? x?.cntrctAmt ?? ""),
        winner: x?.prtcptnEntrpsNm || x?.sucsfnEntrpsNm || "",
      };
    }

    // contract
    const title = x?.cntrctNm || x?.cntrctName || x?.bidNtceNm || "Untitled";
    return {
      title,
      date: x?.cntrctCnclsDate || x?.cntrctDate || "",
      org: x?.dminsttNm || x?.cntrctInsttNm || "",
      amount: prettifyAmount(x?.cntrctAmt ?? x?.contAmt ?? ""),
      period: x?.cntrctPrd || x?.cntrctPeriod || "",
    };
  });

  const filtered = qlc ? mapped.filter((it) => hasQ(it.title) || hasQ(it.org)) : mapped;

  const mkSearchUrl = (keyword) =>
    `https://www.g2b.go.kr:8101/ep/tbid/tbidList.do?bidNm=${encodeURIComponent(keyword || "")}`;

  const withUrl = filtered.slice(0, 20).map((it) => {
    if (kind === "bid" && it._idA) {
      const bidno = String(it._idA);
      const bidseq = String(it._idB || "00").padStart(2, "0");
      const deep =
        `https://www.g2b.go.kr:8081/ep/invitation/publish/bidInfoDtl.do` +
        `?bidno=${encodeURIComponent(bidno)}&bidseq=${encodeURIComponent(bidseq)}` +
        `&releaseYn=Y&taskClCd=5`;
      return { ...it, url: deep, fallbackUrl: mkSearchUrl(it.title) };
    }
    return { ...it, url: mkSearchUrl(it.title), fallbackUrl: mkSearchUrl(it.title) };
  });

  return {
    items: withUrl,
    total: arr.length,
    matched: filtered.length,
  };
}

function prettifyAmount(v) {
  // 숫자 형태면 콤마 찍어서 보기 좋게
  const s = String(v ?? "").trim();
  if (!s) return "";
  const num = Number(String(s).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(num) || num === 0) return s;
  // 소수점 거의 없을 거라 그냥 정수 느낌으로
  const intLike = Math.round(num);
  return intLike.toLocaleString("en-US");
}
