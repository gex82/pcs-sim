import React, { useMemo, useState, useEffect, useRef } from "react";

/**
 * P&C Supply Chain Strategy Simulator — Zero‑dependency build (Enhanced)
 *
 * Adds: Bug fixes #1–#5, OEM profiles, Objective breakdown, Compare view w/ deltas,
 * infeasible banner + bottleneck table, PDF export (window.print), Remote Optimize toggle.
 */

/********************
 * Utility helpers
 ********************/
function seedRandom(seed) {
  let t = seed % 2147483647;
  return () => (t = (t * 48271) % 2147483647) / 2147483647;
}
function formatUSD(n) { return n.toLocaleString(undefined, { style: "currency", currency: "USD" }); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function normalRand() { let u=0,v=0; while(u===0)u=Math.random(); while(v===0)v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }

/********************
 * Data generation
 ********************/
function generateMockNetwork(seed = 42) {
  const rnd = seedRandom(seed);
  const regions = [
    { id: "NA", name: "North America", risk: 0.10, carbon: 0.6 },
    { id: "EU", name: "Europe", risk: 0.08, carbon: 0.5 },
    { id: "AP", name: "Asia Pacific", risk: 0.14, carbon: 0.8 },
    { id: "MX", name: "Mexico", risk: 0.11, carbon: 0.65 },
  ];
  const suppliers = [
    { id: "S1", name: "Supplier A", region: regions[0], unitCost: 120 + 20 * rnd(), leadTimeDays: 18 + Math.floor(6 * rnd()), reliability: 0.96 - 0.03 * rnd(), capacity: 12000, tariffRate: 0.02 },
    { id: "S2", name: "Supplier B", region: regions[2], unitCost: 95 + 15 * rnd(), leadTimeDays: 28 + Math.floor(8 * rnd()), reliability: 0.93 - 0.03 * rnd(), capacity: 18000, tariffRate: 0.05 },
    { id: "S3", name: "Supplier C", region: regions[1], unitCost: 110 + 20 * rnd(), leadTimeDays: 20 + Math.floor(8 * rnd()), reliability: 0.95 - 0.02 * rnd(), capacity: 15000, tariffRate: 0.03 },
    { id: "S4", name: "Supplier D", region: regions[3], unitCost: 100 + 20 * rnd(), leadTimeDays: 22 + Math.floor(5 * rnd()), reliability: 0.94 - 0.02 * rnd(), capacity: 13000, tariffRate: 0.04 },
  ];
  const assemblySites = [
    { id: "A1", name: "Assembly East", region: regions[0], laborCostMultiplier: 1.0, fixedOverhead: 1_000_000, capacity: 15000 },
    { id: "A2", name: "Assembly West", region: regions[0], laborCostMultiplier: 0.95, fixedOverhead: 900_000, capacity: 14000 },
  ];
  const dcs = [ { id: "D1", name: "DC East", region: regions[0] }, { id: "D2", name: "DC West", region: regions[0] } ];
  const lrus = [
    { id: "L1", name: "LRU-Avionics", baseDemand: 8000, bomLaborHours: 2.4, bomScrapRate: 0.02 },
    { id: "L2", name: "LRU-Power Unit", baseDemand: 6500, bomLaborHours: 3.1, bomScrapRate: 0.03 },
    { id: "L3", name: "LRU-Cooling Module", baseDemand: 5000, bomLaborHours: 2.0, bomScrapRate: 0.025 },
  ];
  const transport = {
    air: { costPerTonMi: 0.95, leadPenaltyDays: -5, carbonPerTonMi: 1.8 },
    ocean: { costPerTonMi: 0.12, leadPenaltyDays: +14, carbonPerTonMi: 0.25 },
    ground: { costPerTonMi: 0.35, leadPenaltyDays: 0, carbonPerTonMi: 0.6 },
  };
  const distances = { "NA-NA": 0.8, "AP-NA": 6.2, "EU-NA": 3.8, "MX-NA": 1.1 };
  return { suppliers, assemblySites, dcs, lrus, transport, distances, regions };
}

/********************
 * Scenario templates & OEM profiles
 ********************/
const MASTER_SCENARIOS = [
  { id: "baseline", name: "Baseline" },
  { id: "lowcost", name: "Low-Cost Focus" },
  { id: "service", name: "Service Focus" },
  { id: "resiliency", name: "Resiliency Focus" },
  { id: "sustain", name: "Sustainability Focus" },
];
const VARIANT_MULTIPLIERS = [
  { id: "low", name: "Low Volume", demand: 0.85 },
  { id: "base", name: "Base", demand: 1.0 },
  { id: "high", name: "High", demand: 1.15 },
  { id: "surge", name: "Surge", demand: 1.35 },
  { id: "crisis", name: "Crisis", demand: 0.7 },
];
const OEM_PROFILES = [
  { id: "airbus", name: "Airbus", defaults: { serviceTarget: 0.97, riskWeight: 0.50, carbonPrice: 0.03, tariffMultiplier: 1.10 } },
  { id: "boeing", name: "Boeing", defaults: { serviceTarget: 0.96, riskWeight: 0.40, carbonPrice: 0.02, tariffMultiplier: 1.00 } },
  { id: "pnc", name: "P&C Internal", defaults: { serviceTarget: 0.95, riskWeight: 0.40, carbonPrice: 0.02, tariffMultiplier: 1.00 } },
];

/********************
 * Helpers for edits & loads
 ********************/
function effectiveLrus(lrus, edits) { return lrus.map((l) => ({ ...l, ...(edits[l.id] || {}) })); }
function computeLoads(network, assignment, demandMultiplier, lruEdits) {
  const lrusEff = effectiveLrus(network.lrus, lruEdits);
  const supplierLoad = Object.fromEntries(network.suppliers.map((s) => [s.id, 0]));
  const assemblyLoad = Object.fromEntries(network.assemblySites.map((a) => [a.id, 0]));
  for (const l of lrusEff) {
    const dem = Math.round(l.baseDemand * demandMultiplier);
    const pick = assignment[l.id];
    if (!pick) continue;
    supplierLoad[pick.supplierId] += dem;
    assemblyLoad[pick.assemblyId] += dem;
  }
  const supplierUtil = network.suppliers.map((s) => ({ id: s.id, name: s.name, load: supplierLoad[s.id], cap: s.capacity, util: supplierLoad[s.id] / s.capacity }));
  const assemblyUtil = network.assemblySites.map((a) => ({ id: a.id, name: a.name, load: assemblyLoad[a.id], cap: a.capacity, util: assemblyLoad[a.id] / a.capacity }));
  return { supplierUtil, assemblyUtil };
}

/********************
 * Core calculations (capacity & overflow, per-site penalty)
 ********************/
function evaluateSolution({ assignment, params, network, lruEdits = {} }) {
  const { suppliers, assemblySites, dcs, transport, distances } = network;
  const supMap = Object.fromEntries(suppliers.map((s) => [s.id, s]));
  const asmMap = Object.fromEntries(assemblySites.map((a) => [a.id, a]));
  const dcMap = Object.fromEntries(dcs.map((d) => [d.id, d]));
  const lrus = effectiveLrus(network.lrus, lruEdits);
  const { serviceTarget, laborRate, tariffMultiplier, carbonPrice, inventoryCarryPct, riskWeight, demandMultiplier, allowOverflow } = params;

  let totals = { units: 0, material: 0, tariffs: 0, transportCost: 0, assembly: 0, overhead: 0, inventory: 0, carbonKg: 0, riskIndex: 0, serviceLevel: 1 };
  const supplierCounts = {}; const supLoad = Object.fromEntries(suppliers.map((s) => [s.id, 0])); const asmLoad = Object.fromEntries(assemblySites.map((a) => [a.id, 0]));
  // per-site cost accumulation for accurate penalties and bottlenecks
  const matBySup = Object.fromEntries(suppliers.map((s) => [s.id, 0]));
  const asmCostBySite = Object.fromEntries(assemblySites.map((a) => [a.id, 0]));

  for (const lru of lrus) {
    const pick = assignment[lru.id];
    const sup = supMap[pick.supplierId];
    const asm = asmMap[pick.assemblyId];
    const dc = dcMap[pick.dcId];
    const demand = Math.round(lru.baseDemand * demandMultiplier);
    const scrapFactor = 1 + lru.bomScrapRate;

    const materialCost = demand * scrapFactor * sup.unitCost;
    const tariffs = materialCost * sup.tariffRate * tariffMultiplier;

    const thousandMilesSup = distances[`${sup.region.id}-${asm.region.id}`] ?? 2.0;
    const supModeDef = transport[pick.supMode];
    const tonMilesSup = demand * 0.02 * thousandMilesSup * 1000;
    const transportCostSup = tonMilesSup * supModeDef.costPerTonMi;
    const carbonKgSup = tonMilesSup * supModeDef.carbonPerTonMi;

    const thousandMilesDc = distances[`${asm.region.id}-${dc.region.id}`] ?? 2.0;
    const dcModeDef = transport[pick.dcMode];
    const tonMilesDc = demand * 0.02 * thousandMilesDc * 1000;
    const transportCostDc = tonMilesDc * dcModeDef.costPerTonMi;
    const carbonKgDc = tonMilesDc * dcModeDef.carbonPerTonMi;

    const transportCost = transportCostSup + transportCostDc;
    const carbonKg = carbonKgSup + carbonKgDc;
    const assemblyCost = demand * lru.bomLaborHours * laborRate * asm.laborCostMultiplier;
    const overhead = asm.fixedOverhead * (demand / asm.capacity);

    const cogs = materialCost + tariffs + assemblyCost + overhead + transportCost;
    const inventory = cogs * inventoryCarryPct;

    totals.units += demand;
    totals.material += materialCost;
    totals.tariffs += tariffs;
    totals.transportCost += transportCost;
    totals.assembly += assemblyCost;
    totals.overhead += overhead;
    totals.inventory += inventory;
    totals.carbonKg += carbonKg;

    matBySup[sup.id] += materialCost;
    asmCostBySite[asm.id] += assemblyCost;

    const leadFactor = clamp(1 - Math.max(0, (sup.leadTimeDays + supModeDef.leadPenaltyDays - 20)) / 60, 0.7, 1);
    const lruService = clamp(sup.reliability * leadFactor, 0, 1);
    totals.serviceLevel = Math.min(totals.serviceLevel, lruService);

    supplierCounts[sup.id] = (supplierCounts[sup.id] || 0) + demand;
    supLoad[sup.id] += demand;
    asmLoad[asm.id] += demand;
    const regionRisk = sup.region.risk;
    const relRisk = clamp(1 - sup.reliability, 0, 0.2);
    const modeRiskSup = pick.supMode === "air" ? 0.02 : pick.supMode === "ground" ? 0.04 : 0.06;
    const modeRiskDc = pick.dcMode === "air" ? 0.02 : pick.dcMode === "ground" ? 0.04 : 0.06;
    totals.riskIndex += (regionRisk + relRisk + (modeRiskSup + modeRiskDc) / 2) * (demand / 10000);
  }
  const totalUnits = Object.values(supplierCounts).reduce((a, b) => a + b, 0) || 1;
  const hhi = Object.values(supplierCounts).reduce((acc, u) => acc + Math.pow(u / totalUnits, 2), 0); totals.riskIndex += hhi * 0.5;

  // Accurate per-site overflow penalties
  let overflowPenalty = 0; let serviceDegrade = 0;
  for (const s of suppliers) {
    const load = supLoad[s.id]; if (load > s.capacity) {
      const ratio = (load - s.capacity) / load; if (!allowOverflow) return { totals, cost: Infinity, feasible: false, objective: Infinity, capacity: { supLoad, asmLoad, matBySup, asmCostBySite } };
      overflowPenalty += matBySup[s.id] * ratio * 0.20; serviceDegrade = Math.max(serviceDegrade, 0.03 * ratio * 5);
    }
  }
  for (const a of assemblySites) {
    const load = asmLoad[a.id]; if (load > a.capacity) {
      const ratio = (load - a.capacity) / load; if (!allowOverflow) return { totals, cost: Infinity, feasible: false, objective: Infinity, capacity: { supLoad, asmLoad, matBySup, asmCostBySite } };
      overflowPenalty += asmCostBySite[a.id] * ratio * 0.30; serviceDegrade = Math.max(serviceDegrade, 0.04 * ratio * 5);
    }
  }
  if (serviceDegrade > 0) totals.serviceLevel = clamp(totals.serviceLevel * (1 - serviceDegrade), 0, 1);

  const cost = totals.material + totals.tariffs + totals.transportCost + totals.assembly + totals.overhead + totals.inventory + totals.carbonKg * carbonPrice + overflowPenalty;
  const feasible = totals.serviceLevel >= serviceTarget && cost < Infinity; const objective = cost + riskWeight * totals.riskIndex * 1_000_000;
  return { totals, cost, feasible, objective, capacity: { supLoad, asmLoad, matBySup, asmCostBySite } };
}

function enumerateBestSolution({ network, params, lruEdits }) {
  const { lrus, suppliers, assemblySites, dcs } = network;
  const modes = ["air", "ground", "ocean"];
  let best = null;
  function dfs(idx, currentAssign) {
    if (idx === lrus.length) {
      const res = evaluateSolution({ assignment: currentAssign, params, network, lruEdits });
      if (res.feasible) if (!best || res.objective < best.objective) best = { ...res, assignment: { ...currentAssign } };
      return;
    }
    const lru = lrus[idx];
    for (const s of suppliers)
      for (const a of assemblySites)
        for (const d of dcs)
          for (const m1 of modes)
            for (const m2 of modes) {
              currentAssign[lru.id] = { supplierId: s.id, assemblyId: a.id, dcId: d.id, supMode: m1, dcMode: m2 };
              dfs(idx + 1, currentAssign);
            }
  }
  dfs(0, {});
  return best;
}

/********************
 * Simple Graph (SVG) with draggable nodes & click-to-connect
 ********************/
function useDrag(position, onChange) {
  const ref = useRef(null);
  const baseRef = useRef({ x: position.x, y: position.y });
  useEffect(() => { baseRef.current = { x: position.x, y: position.y }; }, [position.x, position.y]);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    let dragging = false; let startX = 0, startY = 0;
    const down = (e) => { dragging = true; startX = e.clientX; startY = e.clientY; el.setPointerCapture?.(e.pointerId); e.preventDefault(); };
    const move = (e) => { if (!dragging) return; const dx = e.clientX - startX; const dy = e.clientY - startY; onChange({ x: baseRef.current.x + dx, y: baseRef.current.y + dy }); };
    const up = (e) => { dragging = false; try { el.releasePointerCapture?.(e.pointerId); } catch{} };
    el.addEventListener('pointerdown', down); window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    return () => { el.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [onChange]);
  return ref;
}

function Graph({ network, assignment, setAssignment, activeLruId, pendingSupplier, setPendingSupplier, pendingAssembly, setPendingAssembly }) {
  const width = 1000; const height = 520; const nodeW = 140; const nodeH = 36;
  const [positions, setPositions] = useState(() => {
    const p = {}; const xGap = 220;
    network.suppliers.forEach((s, i) => { p[s.id] = { x: 40 + i * xGap, y: 40 }; });
    network.assemblySites.forEach((a, i) => { p[a.id] = { x: 150 + i * xGap, y: 240 }; });
    network.dcs.forEach((d, i) => { p[d.id] = { x: 200 + i * xGap, y: 420 }; });
    return p;
  });
  function setPos(id, xy) { setPositions((prev) => ({ ...prev, [id]: xy })); }
  function centerOf(id) { const p = positions[id]; return { cx: (p?.x || 0) + nodeW / 2, cy: (p?.y || 0) + nodeH / 2 }; }
  const edges = [];
  Object.entries(assignment).forEach(([lruId, pick]) => {
    if (pick.supplierId && pick.assemblyId)
      edges.push({ lruId, from: pick.supplierId, to: pick.assemblyId, mode: pick.supMode, kind: 'sup' });
    if (pick.assemblyId && pick.dcId)
      edges.push({ lruId, from: pick.assemblyId, to: pick.dcId, mode: pick.dcMode, kind: 'dc' });
  });
  const modeStyle = { air: { dash: "0", width: 3 }, ground: { dash: "6 6", width: 2.5 }, ocean: { dash: "2 6", width: 2 } };

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[520px] bg-slate-950">
        {/* edges */}
        {edges.map((e, idx) => { const a = centerOf(e.from); const b = centerOf(e.to); return (
          <g key={idx}>
            <line x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} stroke="#7dd3fc" strokeWidth={modeStyle[e.mode].width} strokeDasharray={modeStyle[e.mode].dash} />
            <rect x={(a.cx + b.cx)/2 - 28} y={(a.cy + b.cy)/2 - 10} width="56" height="18" rx="6" fill="#0b1220" stroke="#1f2937" onClick={() => {
              setAssignment(prev => {
                const cur = prev[e.lruId];
                const field = e.kind === 'sup' ? 'supMode' : 'dcMode';
                const current = cur[field];
                const nextMode = current === 'air' ? 'ground' : current === 'ground' ? 'ocean' : 'air';
                return { ...prev, [e.lruId]: { ...cur, [field]: nextMode } };
              });
            }} style={{ cursor: 'pointer' }} />
            <text x={(a.cx + b.cx)/2} y={(a.cy + b.cy)/2 + 3} textAnchor="middle" fontSize="10" fill="#e2e8f0">{e.lruId}•{e.mode}</text>
          </g>
        ); })}
        {/* nodes */}
        {[...network.suppliers, ...network.assemblySites, ...network.dcs].map((n) => (
          <Node key={n.id} id={n.id} label={(n.name || n.id) + (n.region?` (${n.region.id})`:"")} x={positions[n.id]?.x||0} y={positions[n.id]?.y||0} width={nodeW} height={nodeH}
            onMove={(xy)=> setPos(n.id, xy)}
            onClick={() => {
              if (n.id.startsWith('S')) { setPendingSupplier(n.id); setPendingAssembly(null); }
              if (n.id.startsWith('A')) {
                if (pendingSupplier) { const sId = pendingSupplier; const aId = n.id; setAssignment(prev => ({ ...prev, [activeLruId]: { ...prev[activeLruId], supplierId: sId, assemblyId: aId } })); setPendingSupplier(null); }
                else { setPendingAssembly(n.id); }
              }
              if (n.id.startsWith('D') && pendingAssembly) { const dId = n.id; setAssignment(prev => ({ ...prev, [activeLruId]: { ...prev[activeLruId], dcId: dId } })); setPendingAssembly(null); }
            }}
            armed={(pendingSupplier && n.id === pendingSupplier) || (pendingAssembly && n.id === pendingAssembly)}
          />
        ))}
      </svg>
      <div className="absolute top-2 right-2 text-[11px] text-slate-400">Click Supplier then Assembly to connect • Click Assembly then DC to connect • Click edge tag to change mode</div>
    </div>
  );
}

function Node({ id, label, x, y, width, height, onMove, onClick, armed }) {
  const ref = useDrag({ x, y }, onMove);
  return (
    <foreignObject x={x} y={y} width={width} height={height}>
      <div ref={ref} onClick={onClick} className={`select-none ${armed? 'ring-2 ring-amber-400':''} cursor-move rounded-xl border px-2 py-1 text-xs ${id.startsWith('S')? 'bg-slate-900/90 border-slate-700':'bg-slate-900/70 border-slate-700'}`}>{label}</div>
    </foreignObject>
  );
}

/********************
 * Main component
 ********************/
export default function App() {
  const network = useMemo(() => generateMockNetwork(137), []);
  // Parameters
  const [master, setMaster] = useState("baseline");
  const [variant, setVariant] = useState("base");
  const [serviceTarget, setServiceTarget] = useState(0.95);
  const [laborRate, setLaborRate] = useState(75);
  const [tariffMultiplier, setTariffMultiplier] = useState(1.0);
  const [carbonPrice, setCarbonPrice] = useState(0.02);
  const [inventoryCarryPct, setInventoryCarryPct] = useState(0.12);
  const [riskWeight, setRiskWeight] = useState(0.4);
  const [allowOverflow, setAllowOverflow] = useState(true);
  const [demandVol, setDemandVol] = useState(0.10); // CV
  const [reliabVol, setReliabVol] = useState(0.02); // ±
  const [lruEdits, setLruEdits] = useState({});
  const [activeLruId, setActiveLruId] = useState(network.lrus[0].id);
  const [pendingSupplier, setPendingSupplier] = useState(null);
  const [pendingAssembly, setPendingAssembly] = useState(null);

  // OEM profile
  const [profileId, setProfileId] = useState("pnc");
  function applyProfile(id) {
    const prof = OEM_PROFILES.find(p => p.id === id)?.defaults; if (!prof) return;
    setProfileId(id);
    setServiceTarget(prof.serviceTarget); setRiskWeight(prof.riskWeight); setCarbonPrice(prof.carbonPrice); setTariffMultiplier(prof.tariffMultiplier);
  }

  useEffect(() => { const esc=(e)=>{ if(e.key==='Escape') { setPendingSupplier(null); setPendingAssembly(null); } }; window.addEventListener('keydown', esc); return ()=> window.removeEventListener('keydown', esc); }, []);

  // Derived demand multiplier by scenario & variant
  const demandMultiplier = useMemo(() => {
    const baseMult = VARIANT_MULTIPLIERS.find((v) => v.id === variant)?.demand ?? 1.0;
    switch (master) { case 'service': return baseMult * 1.05; case 'resiliency': return baseMult * 0.98; default: return baseMult; }
  }, [master, variant]);

  const params = useMemo(() => ({ serviceTarget, laborRate, tariffMultiplier, carbonPrice, inventoryCarryPct, riskWeight, demandMultiplier, allowOverflow }), [serviceTarget, laborRate, tariffMultiplier, carbonPrice, inventoryCarryPct, riskWeight, demandMultiplier, allowOverflow]);

  // Assignment (default)
  const [assignment, setAssignment] = useState(() => { const base = {}; network.lrus.forEach((l, i) => { base[l.id] = { supplierId: network.suppliers[i % network.suppliers.length].id, assemblyId: network.assemblySites[i % network.assemblySites.length].id, dcId: network.dcs[i % network.dcs.length].id, supMode: 'ground', dcMode: 'ground' }; }); return base; });

  // Import from share link (no deprecated escape/unescape)
  useEffect(() => {
    try {
      if (location.hash && location.hash.length > 1) {
        const decoded = JSON.parse(decodeURIComponent(atob(location.hash.slice(1))));
        if (decoded.assignment) setAssignment(decoded.assignment);
        if (decoded.params) {
          const p = decoded.params; setServiceTarget(p.serviceTarget ?? 0.95); setLaborRate(p.laborRate ?? 75); setTariffMultiplier(p.tariffMultiplier ?? 1.0); setCarbonPrice(p.carbonPrice ?? 0.02); setInventoryCarryPct(p.inventoryCarryPct ?? 0.12); setRiskWeight(p.riskWeight ?? 0.4); setAllowOverflow(p.allowOverflow ?? true);
        }
        if (decoded.master) setMaster(decoded.master); if (decoded.variant) setVariant(decoded.variant); if (decoded.lruEdits) setLruEdits(decoded.lruEdits); if (decoded.profileId) applyProfile(decoded.profileId);
      }
    } catch {}
  }, []);

  const result = useMemo(() => evaluateSolution({ assignment, params, network, lruEdits }), [assignment, params, network, lruEdits]);
  const loads = useMemo(() => computeLoads(network, assignment, params.demandMultiplier, lruEdits), [network, assignment, params.demandMultiplier, lruEdits]);

  // Optimizer (local vs remote)
  const [optBusy, setOptBusy] = useState(false);
  const [useRemote, setUseRemote] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("https://<your-worker>.workers.dev/optimize");
  async function runOptimize() {
    setOptBusy(true);
    try {
      if (useRemote) {
        const payload = { assignment, params, lruEdits, network };
        const res = await fetch(remoteUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (res.ok) {
          const data = await res.json();
          const bestAssign = data.assignment || data.bestAssignment; if (bestAssign) setAssignment(bestAssign); else { const best = enumerateBestSolution({ network, params, lruEdits }); if (best) setAssignment(best.assignment); }
        } else { const best = enumerateBestSolution({ network, params, lruEdits }); if (best) setAssignment(best.assignment); }
      } else {
        const best = enumerateBestSolution({ network, params, lruEdits }); if (best) setAssignment(best.assignment);
      }
    } catch {
      const best = enumerateBestSolution({ network, params, lruEdits }); if (best) setAssignment(best.assignment);
    } finally { setOptBusy(false); }
  }

  // Monte Carlo (shallow copy suppliers; no JSON deep clone)
  const [mcBusy, setMcBusy] = useState(false); const [mcStats, setMcStats] = useState(null);
  function runMC(samples = 200) {
    setMcBusy(true);
    setTimeout(() => {
      let hits = 0; const costs = [];
      for (let i = 0; i < samples; i++) {
        const dm = params.demandMultiplier * (1 + normalRand() * demandVol);
        const net2 = { ...network, suppliers: network.suppliers.map((s) => ({ ...s, reliability: clamp(s.reliability + normalRand() * reliabVol, 0.80, 0.995) })) };
        const res = evaluateSolution({ assignment, params: { ...params, demandMultiplier: dm }, network: net2, lruEdits });
        if (res.totals.serviceLevel >= params.serviceTarget) hits++; costs.push(res.cost);
      }
      costs.sort((a, b) => a - b); const pct = (p) => costs[Math.floor(clamp(p, 0, 1) * (costs.length - 1))];
      setMcStats({ pService: hits / samples, avgCost: costs.reduce((a, b) => a + b, 0) / samples, p10: pct(0.1), p90: pct(0.9) }); setMcBusy(false);
    }, 10);
  }

  // Sensitivity (use objective)
  const [sens, setSens] = useState(null);
  function runSensitivity() {
    const tests = [
      { key: "serviceTarget", label: "Service Target", delta: 0.02, clamp: [0.8, 0.99] },
      { key: "laborRate", label: "Labor Rate", delta: 10, clamp: [40, 120] },
      { key: "tariffMultiplier", label: "Tariff Multiplier", delta: 0.1, clamp: [0.5, 1.5] },
      { key: "carbonPrice", label: "Carbon Price", delta: 0.01, clamp: [0, 0.10] },
      { key: "inventoryCarryPct", label: "Inventory Carry", delta: 0.02, clamp: [0.05, 0.25] },
      { key: "riskWeight", label: "Risk Weight", delta: 0.1, clamp: [0, 1] },
    ];
    const rows = tests.map((t) => {
      const loR = evaluateSolution({ assignment, params: { ...params, [t.key]: clamp(params[t.key] - t.delta, t.clamp[0], t.clamp[1]) }, network, lruEdits }).objective;
      const hiR = evaluateSolution({ assignment, params: { ...params, [t.key]: clamp(params[t.key] + t.delta, t.clamp[0], t.clamp[1]) }, network, lruEdits }).objective;
      const lo = Number.isFinite(loR) ? loR : NaN; const hi = Number.isFinite(hiR) ? hiR : NaN;
      return { label: t.label, low: lo, high: hi, min: Math.min(lo, hi), max: Math.max(lo, hi), delta: Math.abs(hi - lo) };
    }).filter(r => !isNaN(r.delta)).sort((a, b) => b.delta - a.delta);
    setSens(rows);
  }

  // Save/compare
  const [saved, setSaved] = useState(() => { try { return JSON.parse(localStorage.getItem("pcs_scenarios") || "[]"); } catch { return []; } });
  function saveScenario() { const snap = { id: `${master}-${variant}-${Date.now()}`, master, variant, params, assignment, lruEdits, profileId, metrics: result, ts: new Date().toISOString() }; const next = [snap, ...saved].slice(0, 12); setSaved(next); localStorage.setItem("pcs_scenarios", JSON.stringify(next)); }
  function clearSaved() { setSaved([]); localStorage.removeItem("pcs_scenarios"); }

  // Export / Share / Print
  function downloadJSON() { const blob = new Blob([JSON.stringify({ assignment, params, lruEdits, master, variant, profileId }, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `scenario_${master}_${variant}.json`; a.click(); URL.revokeObjectURL(url); }
  async function copyShareLink() { const payload = { assignment, params, lruEdits, master, variant, profileId }; const url = `${location.origin}${location.pathname}#${btoa(encodeURIComponent(JSON.stringify(payload)))}`; try { await navigator.clipboard.writeText(url); alert("Share link copied to clipboard"); } catch { prompt("Copy link:", url); } }
  function printPDF() { window.print(); }

  // Compare modal
  const [showCompare, setShowCompare] = useState(false);
  const [baselineId, setBaselineId] = useState(null);
  const baseline = useMemo(() => saved.find(s => s.id === baselineId) || saved[0], [saved, baselineId]);

  const infeasible = !result.feasible;

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-100">
      {/* Print CSS */}
      <style>{`@media print{ body{ -webkit-print-color-adjust: exact; print-color-adjust: exact;} .no-print{display:none} .page{page-break-after:always} }`}</style>

      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-950/90 backdrop-blur-md z-40">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400" />
          <div>
            <div className="text-lg font-semibold tracking-tight">P&C Supply Chain Strategy Simulator</div>
            <div className="text-xs text-slate-400">Interactive • Optimizer • Capacity • Monte Carlo • Sensitivity</div>
          </div>
        </div>
        <div className="flex gap-2 items-center no-print">
          <button onClick={runOptimize} className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 transition disabled:opacity-50" disabled={optBusy}>{optBusy ? "Optimizing…" : (useRemote? "Optimize (Remote)" : "Optimize")}</button>
          <button onClick={saveScenario} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700" disabled={infeasible}>Save</button>
          <button onClick={downloadJSON} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700" disabled={infeasible}>Export JSON</button>
          <button onClick={copyShareLink} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700" disabled={infeasible}>Share Link</button>
          <button onClick={() => setShowCompare(true)} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700">Compare</button>
          <button onClick={printPDF} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700">Export PDF</button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4 p-4">
        {/* Left controls */}
        <div className="col-span-3 space-y-4">
          <Panel title="OEM Profile">
            <div className="flex items-center gap-2">
              <Select value={profileId} onChange={(e)=> applyProfile(e.target.value)} options={OEM_PROFILES} />
              <span className="text-[11px] text-slate-500">Applies target, risk weight, carbon, tariff</span>
            </div>
          </Panel>

          <Panel title="Scenario">
            <div className="space-y-2">
              <Label>Master</Label>
              <Select value={master} onChange={(e) => setMaster(e.target.value)} options={MASTER_SCENARIOS} />
              <Label>Variant</Label>
              <Select value={variant} onChange={(e) => setVariant(e.target.value)} options={VARIANT_MULTIPLIERS} />
              <KPI label="Demand Multiplier" value={`${(params.demandMultiplier * 100).toFixed(0)}%`} />
            </div>
          </Panel>

          <Panel title="Targets & Pricing">
            <Range label={`Service Target: ${(serviceTarget * 100).toFixed(0)}%`} min={0.8} max={0.99} step={0.01} value={serviceTarget} onChange={setServiceTarget} />
            <Range label={`Labor Rate: ${formatUSD(laborRate)}/hr`} min={40} max={120} step={1} value={laborRate} onChange={setLaborRate} />
            <Range label={`Tariff Multiplier: ${tariffMultiplier.toFixed(2)}×`} min={0.5} max={1.5} step={0.01} value={tariffMultiplier} onChange={setTariffMultiplier} />
            <Range label={`Inventory Carry: ${(inventoryCarryPct * 100).toFixed(0)}%`} min={0.05} max={0.25} step={0.005} value={inventoryCarryPct} onChange={setInventoryCarryPct} />
            <Range label={`Carbon Price: ${formatUSD(carbonPrice)}/kg`} min={0} max={0.10} step={0.005} value={carbonPrice} onChange={setCarbonPrice} />
            <Range label={`Risk Weight: ${riskWeight.toFixed(2)}`} min={0} max={1} step={0.05} value={riskWeight} onChange={setRiskWeight} />
            <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
              <span>Allow Overflow (OT/3PL)</span>
              <input type="checkbox" checked={allowOverflow} onChange={(e) => setAllowOverflow(e.target.checked)} />
            </div>
          </Panel>

          <Panel title="Uncertainty (Monte Carlo)">
            <Range label={`Demand Volatility (CV): ${(demandVol * 100).toFixed(0)}%`} min={0} max={0.25} step={0.01} value={demandVol} onChange={setDemandVol} />
            <Range label={`Reliability Shock: ±${(reliabVol * 100).toFixed(1)}%`} min={0} max={0.05} step={0.005} value={reliabVol} onChange={setReliabVol} />
            <div className="flex gap-2 mt-2">
              <button onClick={() => runMC(200)} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700" disabled={mcBusy}>{mcBusy ? "Running…" : "Run 200 sims"}</button>
              {mcStats && <div className="text-xs text-slate-400 self-center">P(Service≥T): {(mcStats.pService*100).toFixed(0)}% • Avg {formatUSD(mcStats.avgCost)} • P10 {formatUSD(mcStats.p10)} • P90 {formatUSD(mcStats.p90)}</div>}
            </div>
          </Panel>

          <Panel title="Optimizer Mode (Remote)">
            <div className="text-[11px] text-slate-400 mb-1">Toggle to call a Cloudflare Worker mock; falls back to local if it fails.</div>
            <div className="flex items-center gap-2 mb-2">
              <input type="checkbox" checked={useRemote} onChange={(e)=> setUseRemote(e.target.checked)} />
              <span className="text-xs">Use Remote Optimize</span>
            </div>
            <input className="w-full bg-slate-800 text-slate-100 text-xs rounded-lg px-2 py-1 border border-slate-700" value={remoteUrl} onChange={(e)=> setRemoteUrl(e.target.value)} />
          </Panel>

          <Panel title="Saved Scenarios">
            {saved.length === 0 ? (<div className="text-xs text-slate-400">No saved scenarios yet.</div>) : (
              <div className="space-y-2 max-h-64 overflow-auto">
                {saved.map((s) => (
                  <div key={s.id} className="p-2 rounded-lg bg-slate-800/60 border border-slate-700">
                    <div className="text-xs text-slate-300 flex justify-between">
                      <span>{s.master} • {s.variant}</span>
                      <button className="text-indigo-400 hover:text-indigo-300" onClick={() => { setAssignment(s.assignment); setLruEdits(s.lruEdits||{}); applyProfile(s.profileId||'pnc'); }}>
                        Load
                      </button>
                    </div>
                    <div className="text-[10px] text-slate-500">{new Date(s.ts).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            )}
            <button onClick={clearSaved} className="mt-2 text-xs text-slate-400 hover:text-slate-200">Clear all</button>
          </Panel>
        </div>

        {/* Center: Graph & LRU edits */}
        <div className="col-span-6 space-y-4">
          {infeasible && (
            <div className="rounded-xl bg-rose-950 border border-rose-700 p-3 text-sm text-rose-200">
              Infeasible under current constraints (service target, capacity, overflow policy). Adjust targets, allow overflow, or reassign.
            </div>
          )}

          <Panel title="Network & Flows" subtitle="Pick Active LRU, click Supplier then Assembly, then Assembly then DC to connect. Click edge tag to cycle modes.">
            <div className="flex items-center gap-2 mb-2 text-xs">
              <span className="text-slate-400">Active LRU</span>
              <select className="bg-slate-800 text-slate-100 text-xs rounded-lg px-2 py-1 border border-slate-700" value={activeLruId} onChange={(e) => setActiveLruId(e.target.value)}>
                {network.lrus.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              {pendingSupplier ? <span className="text-amber-400">Supplier selected… pick an Assembly or press ESC</span> : pendingAssembly ? <span className="text-amber-400">Assembly selected… pick a DC or press ESC</span> : null}
            </div>
            <div className="rounded-xl overflow-hidden border border-slate-800">
              <Graph network={network} assignment={assignment} setAssignment={setAssignment} activeLruId={activeLruId} pendingSupplier={pendingSupplier} setPendingSupplier={setPendingSupplier} pendingAssembly={pendingAssembly} setPendingAssembly={setPendingAssembly} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {network.lrus.map((l) => (
                <div key={l.id} className="p-2 rounded-lg bg-slate-900 border border-slate-800">
                  <div className="text-xs text-slate-300 flex justify-between items-center">
                    <span>{l.name}</span>
                    <span className="text-[10px] text-slate-500">{assignment[l.id].supplierId}→{assignment[l.id].assemblyId}→{assignment[l.id].dcId} • {assignment[l.id].supMode}/{assignment[l.id].dcMode}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-1">
                    <NumberInput label="Base Demand" value={(lruEdits[l.id]?.baseDemand ?? l.baseDemand)} onChange={(v) => setLruEdits((p)=>({ ...p, [l.id]: { ...(p[l.id]||{}), baseDemand: v } }))} min={1000} max={30000} step={100} />
                    <NumberInput label="Labor hrs" value={(lruEdits[l.id]?.bomLaborHours ?? l.bomLaborHours)} onChange={(v) => setLruEdits((p)=>({ ...p, [l.id]: { ...(p[l.id]||{}), bomLaborHours: v } }))} min={0.5} max={10} step={0.1} />
                    <NumberInput label="Scrap %" value={((lruEdits[l.id]?.bomScrapRate ?? l.bomScrapRate) * 100)} onChange={(v) => setLruEdits((p)=>({ ...p, [l.id]: { ...(p[l.id]||{}), bomScrapRate: v/100 } }))} min={0} max={15} step={0.5} />
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Capacity Utilization & Bottlenecks">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-slate-400 mb-1">Suppliers</div>
                {loads.supplierUtil.map((s) => <UtilRow key={s.id} name={s.name} load={s.load} cap={s.cap} />)}
              </div>
              <div>
                <div className="text-xs text-slate-400 mb-1">Assembly</div>
                {loads.assemblyUtil.map((a) => <UtilRow key={a.id} name={a.name} load={a.load} cap={a.cap} />)}
              </div>
            </div>
            <div className="mt-3 text-[12px] text-slate-300">
              <div className="mb-1 text-slate-400">Bottlenecks (util ≥ 85%)</div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ...loads.supplierUtil.map(s=>({type:'Supplier', ...s})),
                  ...loads.assemblyUtil.map(a=>({type:'Assembly', ...a}))
                ].filter(x=>x.util>=0.85).sort((a,b)=>b.util-a.util).map(x=> (
                  <div key={`${x.type}-${x.id}`} className="p-2 rounded bg-slate-800 border border-slate-700">
                    <div className="flex justify-between"><span>{x.type}: {x.name}</span><span>{Math.round(x.util*100)}%</span></div>
                    <div className="text-slate-400">{Math.round(x.load)}/{x.cap}</div>
                  </div>
                ))}
                {[
                  ...loads.supplierUtil.map(s=>s.util),
                  ...loads.assemblyUtil.map(a=>a.util)
                ].every(u=>u<0.85) && <div className="text-slate-500">No bottlenecks.</div>}
              </div>
            </div>
          </Panel>
        </div>

        {/* Right: KPIs & Charts */}
        <div className="col-span-3 space-y-4">
          <Panel title="KPIs (per year)">
            <div className="grid grid-cols-2 gap-2">
              <KPI label="Total Cost" value={formatUSD(result.cost)} />
              <KPI label="Service Level" value={`${(result.totals.serviceLevel * 100).toFixed(1)}%`} />
              <KPI label="Material" value={formatUSD(result.totals.material)} />
              <KPI label="Tariffs" value={formatUSD(result.totals.tariffs)} />
              <KPI label="Transport" value={formatUSD(result.totals.transportCost)} />
              <KPI label="Assembly" value={formatUSD(result.totals.assembly)} />
              <KPI label="Inventory" value={formatUSD(result.totals.inventory)} />
              <KPI label="Carbon" value={`${Math.round(result.totals.carbonKg).toLocaleString()} kg`} />
              <KPI label="Risk Index" value={result.totals.riskIndex.toFixed(3)} />
            </div>
          </Panel>

          <Panel title="Objective Breakdown">
            <ObjectiveBreakdown cost={result.cost} riskIndex={result.totals.riskIndex} riskWeight={riskWeight} />
          </Panel>

          <Panel title="Cost Breakdown (stacked)">
            <StackedBar rows={[{ key: 'Material', v: result.totals.material }, { key: 'Tariffs', v: result.totals.tariffs }, { key: 'Transport', v: result.totals.transportCost }, { key: 'Assembly', v: result.totals.assembly }, { key: 'Overhead', v: result.totals.overhead }, { key: 'Inventory', v: result.totals.inventory }]} />
          </Panel>

          <Panel title="Service vs Target">
            <DualBar left={{ label: 'Service', value: result.totals.serviceLevel * 100 }} right={{ label: 'Target', value: serviceTarget * 100 }} />
          </Panel>

          <Panel title="Sensitivity (Tornado) & Compare">
            <div className="flex gap-2 mb-2">
              <button onClick={runSensitivity} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700">Run Sensitivity</button>
            </div>
            {sens && <Tornado rows={sens} />}
            {saved.length > 0 && (
              <div className="mt-3 text-[11px] text-slate-300 border-t border-slate-800 pt-2">
                <div className="mb-1 text-slate-400">Saved Scenario Snapshots</div>
                <div className="space-y-1 max-h-36 overflow-auto">
                  {saved.map((s) => (
                    <div key={s.id} className="grid grid-cols-4 gap-2">
                      <div className="truncate">{s.master}/{s.variant}</div>
                      <div>{formatUSD(s.metrics.cost)}</div>
                      <div>{(s.metrics.totals.serviceLevel*100).toFixed(1)}%</div>
                      <div>{s.metrics.totals.riskIndex.toFixed(3)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Panel>
        </div>
      </div>

      {/* Compare Modal */}
      {showCompare && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="w-[880px] max-h-[80vh] overflow-auto rounded-2xl bg-slate-900 border border-slate-700 p-4">
            <div className="flex justify-between items-center mb-3">
              <div className="text-slate-200 font-semibold">Compare Saved Scenarios</div>
              <button className="text-slate-300" onClick={()=> setShowCompare(false)}>Close</button>
            </div>
            {saved.length < 2 ? (
              <div className="text-slate-400 text-sm">Save at least two scenarios to compare.</div>
            ) : (
              <div>
                <div className="flex items-center gap-2 mb-2 text-xs text-slate-400">
                  <span>Baseline</span>
                  <select className="bg-slate-800 text-slate-100 text-xs rounded-lg px-2 py-1 border border-slate-700" value={baseline?.id||''} onChange={(e)=> setBaselineId(e.target.value)}>
                    {saved.map(s=> <option key={s.id} value={s.id}>{s.master}/{s.variant} • {new Date(s.ts).toLocaleTimeString()}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-6 gap-2 text-[12px] text-slate-300 border-b border-slate-700 pb-1">
                  <div>Scenario</div>
                  <div className="text-right">Objective</div>
                  <div className="text-right">Cost</div>
                  <div className="text-right">Service</div>
                  <div className="text-right">RiskIdx</div>
                  <div className="text-right">Δ vs Base</div>
                </div>
                <div className="max-h-[50vh] overflow-auto">
                  {saved.map((s) => {
                    const obj = s.metrics.cost + s.params.riskWeight * s.metrics.totals.riskIndex * 1_000_000;
                    const baseObj = baseline ? (baseline.metrics.cost + baseline.params.riskWeight * baseline.metrics.totals.riskIndex * 1_000_000) : obj;
                    const delta = obj - baseObj; const pct = baseObj ? (delta/baseObj*100) : 0;
                    return (
                      <div key={s.id} className="grid grid-cols-6 gap-2 text-[12px] text-slate-200 py-1 border-b border-slate-800">
                        <div className="truncate">{s.master}/{s.variant}</div>
                        <div className="text-right">{formatUSD(obj)}</div>
                        <div className="text-right">{formatUSD(s.metrics.cost)}</div>
                        <div className="text-right">{(s.metrics.totals.serviceLevel*100).toFixed(1)}%</div>
                        <div className="text-right">{s.metrics.totals.riskIndex.toFixed(3)}</div>
                        <div className={`text-right ${delta>0?'text-rose-400':'text-emerald-400'}`}>{delta>0?'+':''}{formatUSD(delta)} ({pct.toFixed(1)}%)</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="px-6 py-6 border-t border-slate-800 grid grid-cols-12 gap-4">
        <div className="col-span-6 text-sm text-slate-300">
          <div className="font-semibold mb-1">How to use</div>
          <ul className="list-disc ml-5 space-y-1 text-slate-400">
            <li>Select an OEM profile, scenario, and variant; tune targets & prices; toggle overflow policy.</li>
            <li>Pick an Active LRU, then click Supplier and Assembly, then Assembly and DC to assign. Click edge tag to cycle modes.</li>
            <li>Run Optimize (local or remote) to meet service at lowest objective under constraints.</li>
            <li>Use Monte Carlo for uncertainty; Sensitivity for most impactful levers; Compare for deltas.</li>
            <li>Save scenarios, export JSON, share a URL, or Export PDF (print) for execs.</li>
          </ul>
        </div>
        <div className="col-span-6 text-sm text-slate-400">
          <div className="font-semibold text-slate-300 mb-1">Assumptions & Notes</div>
          <ul className="list-disc ml-5 space-y-1">
            <li>Illustrative single-period model; service ≈ reliability × lead factor; risk blends region, reliability, mode, HHI.</li>
            <li>Capacity overflow adds surcharges & service degradation unless disallowed (then infeasible).</li>
            <li>Remote optimize endpoint is a mock API for demo; swap in true solver later.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

/********************
 * Small UI primitives & charts (no external libs)
 ********************/
function Panel({ title, subtitle, children }) { return (
  <div className="rounded-2xl bg-slate-900/60 border border-slate-800 p-3">
    <div className="mb-2"><div className="text-sm font-semibold text-slate-100">{title}</div>{subtitle && <div className="text-xs text-slate-500">{subtitle}</div>}</div>{children}
  </div>
); }
function Label({ children }) { return <div className="text-xs text-slate-400 mb-1">{children}</div>; }
function KPI({ label, value }) { return (
  <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-2"><div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div><div className="text-base font-semibold text-slate-100">{value}</div></div>
); }
function Select({ value, onChange, options }) { return (
  <select value={value} onChange={onChange} className="w-full bg-slate-800 text-slate-100 text-sm rounded-xl px-3 py-2 border border-slate-700">
    {options.map((o) => (<option key={o.id} value={o.id}>{o.name}</option>))}
  </select>
); }
function Range({ label, min, max, step, value, onChange }) { return (
  <div className="mt-2"><div className="flex items-center justify-between text-xs text-slate-400 mb-1"><span>{label}</span><span className="text-slate-500">{typeof value === 'number' ? value.toFixed(2) : value}</span></div><input type="range" min={min} max={max} step={step} value={value} onChange={(e)=> onChange(parseFloat(e.target.value))} className="w-full accent-indigo-500" /></div>
); }
function NumberInput({ label, value, onChange, min=0, max=1e9, step=1 }) { return (
  <div className="text-[11px]"><div className="text-slate-500 mb-1">{label}</div><input type="number" value={value} min={min} max={max} step={step} onChange={(e)=> onChange(parseFloat(e.target.value))} className="w-full bg-slate-800 text-slate-100 rounded-lg px-2 py-1 border border-slate-700" /></div>
); }
function UtilRow({ name, load, cap }) { const util = load / (cap || 1); return (
  <div className="mb-2"><div className="flex justify-between text-[11px] text-slate-400"><span className="truncate mr-2">{name}</span><span>{Math.round(load)}/{cap}</span></div><div className="h-2 bg-slate-800 rounded"><div className={`h-2 rounded ${util>1? 'bg-rose-500' : util>0.85? 'bg-amber-500':'bg-indigo-500'}`} style={{ width: `${Math.min(100, util*100)}%` }} /></div></div>
); }
function StackedBar({ rows }) { const total = rows.reduce((a, r) => a + r.v, 0) || 1; return (
  <div className="p-2"><div className="h-6 w-full bg-slate-800 rounded overflow-hidden flex">{rows.map((r, i) => (<div key={r.key} title={`${r.key}: ${formatUSD(r.v)}`} className="h-6" style={{ width: `${(r.v/total)*100}%`, background: i%2? '#334155':'#475569' }} />))}</div><div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-slate-300">{rows.map((r) => (<div key={r.key} className="flex justify-between"><span>{r.key}</span><span>{formatUSD(r.v)}</span></div>))}</div></div>
); }
function DualBar({ left, right }) { return (
  <div className="p-2 text-[11px]"><div className="mb-2"><div className="flex justify-between text-slate-300"><span>{left.label}</span><span>{left.value.toFixed(1)}%</span></div><div className="h-3 bg-slate-800 rounded"><div className="h-3 bg-indigo-500 rounded" style={{ width: `${clamp(left.value,0,100)}%` }} /></div></div><div className="mb-2"><div className="flex justify-between text-slate-300"><span>{right.label}</span><span>{right.value.toFixed(1)}%</span></div><div className="h-3 bg-slate-800 rounded"><div className="h-3 bg-indigo-500 rounded" style={{ width: `${clamp(right.value,0,100)}%` }} /></div></div></div>
); }
function Tornado({ rows }) { const maxDelta = rows[0]?.delta || 1; return (
  <div className="p-2 text-[11px] space-y-1 max-h-48 overflow-auto">{rows.map((r) => (<div key={r.label}><div className="flex justify-between text-slate-300"><span>{r.label}</span><span>{formatUSD(r.min)} → {formatUSD(r.max)}</span></div><div className="h-3 bg-slate-800 rounded"><div className="h-3 bg-amber-500 rounded" style={{ width: `${(r.delta/maxDelta)*100}%` }} /></div></div>))}</div>
); }
function ObjectiveBreakdown({ cost, riskIndex, riskWeight }) { const riskTerm = riskWeight * riskIndex * 1_000_000; const obj = cost + riskTerm; return (
  <div className="text-[12px] text-slate-200 space-y-1"><div className="flex justify-between"><span>Cost</span><span>{formatUSD(cost)}</span></div><div className="flex justify-between"><span>Risk Term</span><span>{formatUSD(riskTerm)}</span></div><div className="flex justify-between font-semibold"><span>Objective</span><span>{formatUSD(obj)}</span></div><div className="text-slate-400">Objective = Cost + RiskWeight × RiskIndex × 1,000,000</div></div>
); }