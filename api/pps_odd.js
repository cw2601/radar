// api/pps.js (Vercel Serverless Function)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kind = req.query.kind || "bid";
    const q = String(req.query.q ?? "").trim();
    const serviceKeyRaw = process.env.DATA_GO_KR_SERVICE_KEY;
    
    if (!serviceKeyRaw) return res.status(500).json({ error: "Missing Key" });
    const serviceKey = serviceKeyRaw.includes("%") ? serviceKeyRaw : encodeURIComponent(serviceKeyRaw);

    const base = "https://apis.data.go.kr/1230000/ao/PubDataOpnStdService";
    const endpointByKind = {
      bid: `${base}/getDataSetOpnStdBidPblancInfo`,
      award: `${base}/getDataSetOpnStdScsbidInfo`,
      contract: `${base}/getDataSetOpnStdCntrctInfo`,
    };

    const endpoint = endpointByKind[kind] || endpointByKind.bid;

    // --- KST 기준 날짜 범위 계산 (기존 설정 유지) ---
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const daysBack = kind === "award" ? 6 : 29;
    const fromDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

    const fmt = (d) => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      return `${y}${m}${day}`;
    };

    const fromYmd = fmt(fromDate);
    const toYmd = fmt(now);

    const params = new URLSearchParams({
      serviceKey,
      type: "json",
      pageNo: "1",
      numOfRows: "100",
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
    const response = await fetch(url);
    const text = await response.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Non-JSON response", detail: text.slice(0, 200) });
    }

    // 데이터 추출
    let list = json?.response?.body?.items ?? [];
    if (!Array.isArray(list) && list?.item) list = list.item;
    const arr = Array.isArray(list) ? list : [list].filter(Boolean);

    const items = arr.map(x => {
      const title = x.bidNtceNm || x.cntrctNm || "제목 없음";
      const org = x.ntceInsttNm || x.dminsttNm || x.cntrctInsttNm || "";
      const date = x.bidNtceDate || x.opengDate || x.cntrctCnclsDate || "";
      const amount = x.asignBdgtAmt || x.scsbidAmt || x.cntrctAmt || "0";
      
      let detailUrl = `https://www.g2b.go.kr:8101/ep/tbid/tbidList.do?bidNm=${encodeURIComponent(title)}`;
      if (kind === "bid" && x.bidNtceNo) {
        detailUrl = `https://www.g2b.go.kr:8081/ep/invitation/publish/bidInfoDtl.do?bidno=${x.bidNtceNo}&bidseq=${(x.bidNtceOrd || "00").padStart(2, "0")}&releaseYn=Y&taskClCd=5`;
      }

      return {
        kind,
        title,
        org,
        date,
        amount: formatAmount(amount),
        status: x.bidNtceSttusNm || "",
        winner: x.prtcptnEntrpsNm || x.sucsfnEntrpsNm || "",
        period: x.cntrctPrd || "",
        url: detailUrl
      };
    });

    return res.status(200).json({ items });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function formatAmount(v) {
  const n = parseInt(String(v || "0").replace(/[^0-9]/g, ""), 10);
  if (isNaN(n) || n === 0) return "0";
  return n.toLocaleString("ko-KR");
}
