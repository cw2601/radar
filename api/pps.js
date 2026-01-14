// api/pps.js (Vercel Serverless Function)
export default async function handler(req, res) {
  try {
    const kind = String(req.query.kind || "bid"); // bid | award | contract
    const qRaw = String(req.query.q || "AI").trim();
    const q = qRaw.slice(0, 60); // 너무 긴 키워드 방지

    const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
    if (!serviceKey) {
      return res.status(500).json({ error: "Missing DATA_GO_KR_SERVICE_KEY" });
    }

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

    // --- KST 기준으로 날짜 만들기 (Vercel은 UTC라서 +9h로 맞춤)
    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const y = kstNow.getUTCFullYear();
    const m = pad(kstNow.getUTCMonth() + 1);
    const d = pad(kstNow.getUTCDate());
    const hh = pad(kstNow.getUTCHours());
    const mi = pad(kstNow.getUTCMinutes());

    // 기간 계산 (API 제한 반영)
    const msDay = 24 * 60 * 60 * 1000;
    const daysBack =
      kind === "award" ? 6 : 29; // award는 1주일 제한(대충 7일), bid/contract는 1개월 제한(대충 30일)
    const fromKst = new Date(kstNow.getTime() - daysBack * msDay);

    const fy = fromKst.getUTCFullYear();
    const fm = pad(fromKst.getUTCMonth() + 1);
    const fd = pad(fromKst.getUTCDate());
    const fhh = pad(fromKst.getUTCHours());
    const fmi = pad(fromKst.getUTCMinutes());

    // --- kind별 파라미터 구성 (너가 준 공식 요청변수 그대로)
    const params = new URLSearchParams({
      serviceKey,
      type: "json",
      pageNo: "1",
      numOfRows: "50",
    });

    if (kind === "bid") {
      // bidNtceBgnDt / bidNtceEndDt : YYYYMMDDHHMM (1개월 제한)
      params.set("bidNtceBgnDt", `${fy}${fm}${fd}0000`);
      params.set("bidNtceEndDt", `${y}${m}${d}2359`);
    }

    if (kind === "award") {
      // opengBgnDt / opengEndDt : YYYYMMDDHHMM (1주일 제한)
      params.set("opengBgnDt", `${fy}${fm}${fd}0000`);
      params.set("opengEndDt", `${y}${m}${d}2359`);
      // bsnsDivCd: 1=물품,2=외자,3=공사,5=용역  (기본은 용역으로 두고 싶으면 5)
      params.set("bsnsDivCd", String(req.query.bsnsDivCd || "5"));
    }

    if (kind === "contract") {
      // cntrctCnclsBgnDate / cntrctCnclsEndDate : YYYYMMDD (1개월 제한)
      params.set("cntrctCnclsBgnDate", `${fy}${fm}${fd}`);
      params.set("cntrctCnclsEndDate", `${y}${m}${d}`);
    }

    const url = `${endpoint}?${params.toString()}`;

    const r = await fetch(url);
    const text = await r.text();

    if (!r.ok) {
      return res.status(502).json({
        error: `Upstream ${r.status}`,
        detail: text.slice(0, 800),
        sourceUrl: url,
      });
    }

    // data.go.kr은 가끔 JSON인데도 text로 내려오는 경우가 있어서 안전 처리
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "Upstream returned non-JSON (check serviceKey encoding or params)",
        detail: text.slice(0, 800),
        sourceUrl: url,
      });
    }

    const items = extractItems(json, kind, q);

    // Vercel edge cache (10분)
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
    return res.status(200).json({
      kind,
      q,
      items,
      sourceUrl: url,
      fetchedAt: new Date().toISOString(),
      kstRange:
        kind === "contract"
          ? `${fy}-${fm}-${fd} ~ ${y}-${m}-${d}`
          : `${fy}-${fm}-${fd} ~ ${y}-${m}-${d}`,
    });
  } catch (e) {
    return res.status(500).json({ error: "Proxy failed", message: String(e?.message || e) });
  }
}

function extractItems(raw, kind, q) {
  const list = raw?.response?.body?.items?.item || [];
  const arr = Array.isArray(list) ? list : [list].filter(Boolean);

  const qlc = (q || "").toLowerCase();
  const hasQ = (s) => (String(s || "").toLowerCase().includes(qlc));

  // kind별 “타이틀 필드” 추정 (나라장터 표준 응답에서 흔히 이렇게 옴)
  const mapped = arr.map((x) => {
    if (kind === "bid") {
      const title = x?.bidNtceNm || x?.bidNtceName || x?.bidNm || "Untitled";
      const bidNo = x?.bidNtceNo || x?.bidNtceNum || "";
      const bidOrd = x?.bidNtceOrd || x?.bidNtceSeq || "";
      return {
        title,
        date: [x?.bidNtceDt, x?.bidNtceDate, x?.bidNtceTime].filter(Boolean).join(" "),
        org: x?.ntceInsttNm || x?.dminsttNm || x?.ntceInsttName || "",
        amount: x?.asignBdgtAmt || x?.presmPrce || "",
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
        amount: x?.scsbidAmt || x?.scsbidPrice || x?.cntrctAmt || "",
        winner: x?.prtcptnEntrpsNm || x?.sucsfnEntrpsNm || "",
      };
    }

    // contract
    const title = x?.cntrctNm || x?.cntrctName || x?.bidNtceNm || "Untitled";
    return {
      title,
      date: x?.cntrctCnclsDate || x?.cntrctDate || "",
      org: x?.dminsttNm || x?.cntrctInsttNm || "",
      amount: x?.cntrctAmt || x?.contAmt || "",
      period: x?.cntrctPrd || x?.cntrctPeriod || "",
    };
  });

  // 서버에서 키워드 필터 (API가 keyword 지원 안 하니까 여기서 처리)
  const filtered = qlc
    ? mapped.filter((it) => hasQ(it.title) || hasQ(it.org))
    : mapped;

  // 클릭 URL: 확실한 딥링크는 항목마다 파라미터가 들쭉날쭉해서,
  // 1) bid는 bidno/bidseq 있으면 bidInfoDtl 딥링크를 "시도"
  // 2) 없으면 나라장터 검색 리스트로 보냄
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

  return withUrl;
}
