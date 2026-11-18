// Auswahl der Werte, unter denen der Handelsautomat wählt (Yahoo-Symbole).
//
// Bewusst nach einer festen Regel statt von Hand: alle Werte aus DAX 40 und Nasdaq 100 (Stand 2026),
// fünf breite ETFs und neun große Kryptowährungen. Eine handverlesene Liste mit den Gewinnern von heute
// würde den Backtest stark schönen (im Test: +89 % statt +53 % über 3 Jahre).
// US-Aktien rechnet der Automat mit dem Tageswechselkurs in Euro um.
import type { Wert } from "./handel.ts";

const DAX = "ADS AIR ALV BAS BAYN BEI BMW BNR CBK CON DTG DBK DB1 DHL DTE EOAN FRE G1A HNR1 HEI HEN3 IFX MBG MRK MTX MUV2 "
  + "P911 PAH3 QIA RHM RWE SAP SRT3 SIE ENR SHL SY1 VOW3 VNA ZAL";
const NASDAQ = "AAPL ABNB ADBE ADI ADP ADSK AEP AMAT AMD AMGN AMZN APP ARM ASML AVGO AXON AZN BIIB BKNG BKR CCEP CDNS CDW "
  + "CEG CHTR CMCSA COST CPRT CRWD CSCO CSGP CSX CTAS CTSH DASH DDOG DXCM EXC FANG FAST FTNT GEHC GFS GILD GOOGL HON IDXX "
  + "INTC INTU ISRG KDP KHC KLAC LIN LRCX LULU MAR MCHP MDB MDLZ MELI META MNST MRVL MSFT MSTR MU NFLX NVDA NXPI ODFL ON "
  + "ORLY PANW PAYX PCAR PDD PEP PLTR PYPL QCOM REGN ROP ROST SBUX SNPS TEAM TMUS TSLA TTD TTWO TXN VRSK VRTX WDAY XEL ZS";
const ETFS: [string, string][] = [["EUNL.DE", "iShares Core MSCI World"], ["SXR8.DE", "iShares Core S&P 500"],
  ["EXS1.DE", "iShares Core DAX"], ["IS3N.DE", "iShares Core MSCI EM IMI"], ["SXRV.DE", "iShares Nasdaq 100"]];
const KRYPTO: [string, string][] = [["BTC-EUR", "Bitcoin"], ["ETH-EUR", "Ethereum"], ["SOL-EUR", "Solana"], ["XRP-EUR", "XRP"],
  ["BNB-EUR", "BNB"], ["ADA-EUR", "Cardano"], ["AVAX-EUR", "Avalanche"], ["DOGE-EUR", "Dogecoin"], ["LINK-EUR", "Chainlink"]];

export const UNIVERSUM: Wert[] = [
  ...DAX.split(" ").map((s): Wert => ({ kennung: s + ".DE", name: s, klasse: "aktie" })),
  ...NASDAQ.split(" ").map((s): Wert => ({ kennung: s, name: s, klasse: "aktie" })),
  ...ETFS.map(([kennung, name]): Wert => ({ kennung, name, klasse: "etf" })),
  ...KRYPTO.map(([kennung, name]): Wert => ({ kennung, name, klasse: "krypto" })),
];
