// api/pps.js (Vercel Serverless Function)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kind = req.query.kind || "bid";
    const q = String(req.query.q || "").trim();

    const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
    if (!serviceKey) return res.status(500).json({ error: "Missing Key" });

    const base = "https://apis.data.go.kr/1230000/ao/PubDataOpnStdService";
    const endpointByKind = {
      bid: `${base}/getDataSetOpnStdBidPblancInfo`,
      award: `${base}/getDataSetOpnStdScsbidInfo`,
      contract: `${base}/getDataSetOpnStdCntrctInfo`,
    };

    const endpoint = endpointByKind[kind] || endpointByKind.bid;

    // --- KST 기준 1년(365일) 날짜 범위 계산 ---
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const fromDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); // 1년 전

    const fmt = (d) => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      return `${y}${m}${day}`;
    };

    const fromYmd = fmt(fromDate);
    const toYmd = fmt(now);

    const params = new URLSearchParams({
      serviceKey: serviceKey.includes("%") ? serviceKey : encodeURIComponent(serviceKey),
      type: "json",
      pageNo: "1",
      numOfRows: "200", // 검색 범위를 넓히기 위해 로우 수 상향
    });

    if (kind === "bid") {
      params.set("bidNtceBgnDt", `${fromYmd}0000`);
      params.set("bidNtceEndDt", `${toYmd}2359`);
    } else if (kind === "award") {
      params.set("opengBgnDt", `${fromYmd}0000`);
      params.set("opengEndDt", `${toYmd}2359`);
      params.set("bsnsDivCd", req.query.bsnsDivCd || "5");
    } else if (kind === "contract") {
      params.set("cntrctCnclsBgnDate", fromYmd);
      params.set("cntrctCnclsEndDate", toYmd);
    }

    const url = `${endpoint}?${params.toString()}`;
    const r = await fetch(url);
    const text = await r.text();
    
    let json;
    try { json = JSON.parse(text); } catch { return res.status(502).json({ error: "API Error", detail: text }); }

    // 데이터 추출 및 필터링
    let list = json?.response?.body?.items || [];
    if (!Array.isArray(list) && list?.item) list = list.item;
    const arr = Array.isArray(list) ? list : [list].filter(Boolean);

    const qlc = q.toLowerCase();
    const items = arr.map(x => {
      const it = {
        title: x.bidNtceNm || x.cntrctNm || "제목없음",
        date: x.bidNtceDate || x.opengDate || x.cntrctCnclsDate || "",
        org: x.ntceInsttNm || x.dminsttNm || "",
        amount: (x.asignBdgtAmt || x.scsbidAmt || x.cntrctAmt || "0").toLocaleString(),
        status: x.bidNtceSttusNm || "",
        winner: x.prtcptnEntrpsNm || "",
        period: x.cntrctPrd || "",
        url: `https://www.g2b.go.kr:8101/ep/tbid/tbidList.do?bidNm=${encodeURIComponent(x.bidNtceNm || x.cntrctNm)}`
      };
      
      // BID 상세 페이지 링크 생성 로직
      if (kind === "bid" && x.bidNtceNo) {
        it.url = `https://www.g2b.go.kr:8081/ep/invitation/publish/bidInfoDtl.do?bidno=${x.bidNtceNo}&bidseq=${(x.bidNtceOrd || "00").padStart(2, "0")}&releaseYn=Y&taskClCd=5`;
      }
      return it;
    }).filter(it => !q || it.title.toLowerCase().includes(qlc) || it.org.toLowerCase().includes(qlc));

    res.setHeader("Cache-Control", "s-maxage=600");
    return res.status(200).json({ items });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
