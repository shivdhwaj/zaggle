import { useState, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList } from 'recharts';

// ============================================================
// TAX LOGIC — FY 2026-27 (Budget 2025 + Income-tax Rules, 2026)
// Every step below cites its statutory source. If you audit this
// file, start here and follow the comments — the math is built in
// four separate layers so each can be verified independently.
// ============================================================

// LAYER 1 — Normal slab tax
// NTR under Section 115BAC (soon Section 202 of IT Act 2025)
// OTR under the regular slab structure (unchanged in Budget 2025)
const NTR_SLABS = [
  { upto: 400000,  rate: 0.00 },
  { upto: 800000,  rate: 0.05 },
  { upto: 1200000, rate: 0.10 },
  { upto: 1600000, rate: 0.15 },
  { upto: 2000000, rate: 0.20 },
  { upto: 2400000, rate: 0.25 },
  { upto: Infinity,rate: 0.30 },
];
const OTR_SLABS = [
  { upto: 250000,   rate: 0.00 },
  { upto: 500000,   rate: 0.05 },
  { upto: 1000000,  rate: 0.20 },
  { upto: Infinity, rate: 0.30 },
];

// LAYER 3 — Surcharge thresholds (computed on basic tax AFTER rebate)
// NTR caps surcharge at 25% (the 37% bracket was abolished for NTR);
// OTR still has the 37% bracket above ₹5Cr for the super-rich.
const NTR_SURCHARGE_BRACKETS = [
  { threshold: 5000000,  rate: 0.10 }, // > ₹50L
  { threshold: 10000000, rate: 0.15 }, // > ₹1Cr
  { threshold: 20000000, rate: 0.25 }, // > ₹2Cr  (NTR ceiling)
];
const OTR_SURCHARGE_BRACKETS = [
  { threshold: 5000000,  rate: 0.10 },
  { threshold: 10000000, rate: 0.15 },
  { threshold: 20000000, rate: 0.25 },
  { threshold: 50000000, rate: 0.37 }, // > ₹5Cr (OTR only)
];

// ---- STEP 1: compute the basic slab tax on taxable income ----
// This is pure arithmetic on the slab table — no rebate, no surcharge, no cess yet.
function computeSlabTax(taxableIncome, regime) {
  if (taxableIncome <= 0) return 0;
  const slabs = regime === 'NTR' ? NTR_SLABS : OTR_SLABS;
  let remaining = taxableIncome;
  let prev = 0;
  let tax = 0;
  for (const s of slabs) {
    if (remaining <= 0) break;
    const slabSize = s.upto - prev;
    const taxedInThisSlab = Math.min(remaining, slabSize);
    tax += taxedInThisSlab * s.rate;
    remaining -= taxedInThisSlab;
    prev = s.upto;
  }
  return tax;
}

// ---- STEP 2: Section 87A rebate, WITH marginal relief ----
// NTR: ₹60,000 rebate if taxable income ≤ ₹12,00,000 (Budget 2025).
//   Marginal relief (critical!): if income marginally exceeds ₹12L,
//   tax payable cannot exceed the excess above ₹12L. This prevents
//   the cliff where earning ₹1 more costs you ₹60,000+ in tax.
//   The relief tapers out at approximately ₹12,70,588 where normal
//   slab tax equals the excess.
// OTR: ₹12,500 rebate if taxable income ≤ ₹5,00,000.
function applyRebate(basicTax, taxableIncome, regime) {
  if (regime === 'NTR') {
    if (taxableIncome <= 1200000) {
      return Math.max(0, basicTax - 60000);
    }
    // Marginal relief band
    const excess = taxableIncome - 1200000;
    if (basicTax > excess) return excess;
    return basicTax;
  }
  // OTR
  if (taxableIncome <= 500000) return Math.max(0, basicTax - 12500);
  return basicTax;
}

// ---- STEP 3: Surcharge on basic tax (after rebate), WITH marginal relief ----
// Surcharge is a tax-on-tax for high earners. Without marginal relief,
// earning ₹1 more than ₹50L would cause the ENTIRE tax-so-far to attract
// 10% extra — a discontinuity of lakhs. Marginal relief caps the total
// tax increase at the income increase above the threshold.
function computeSurcharge(basicTaxAfterRebate, taxableIncome, regime) {
  const brackets = regime === 'NTR' ? NTR_SURCHARGE_BRACKETS : OTR_SURCHARGE_BRACKETS;

  // Identify which bracket this income lands in (highest threshold crossed)
  let currentRate = 0;
  let currentThreshold = 0;
  let prevRate = 0;
  for (const b of brackets) {
    if (taxableIncome > b.threshold) {
      prevRate = currentRate;        // rate that applied just BELOW this threshold
      currentRate = b.rate;
      currentThreshold = b.threshold;
    }
  }
  if (currentRate === 0) return 0; // taxable income ≤ ₹50L, no surcharge

  const normalSurcharge = basicTaxAfterRebate * currentRate;

  // Marginal relief: (basic + surcharge) at income I cannot exceed
  // (basic + surcharge) at threshold + (I − threshold).
  // We compute the "tax at threshold" using the PREVIOUS bracket's surcharge rate
  // (because at exactly the threshold, the higher rate hasn't kicked in yet).
  const basicAtThreshold = computeSlabTax(currentThreshold, regime);
  // 87A rebate never applies at these thresholds (all ≥ ₹50L), so skip
  const surchargeAtThreshold = basicAtThreshold * prevRate;
  const totalAtThreshold = basicAtThreshold + surchargeAtThreshold;
  const cap = totalAtThreshold + (taxableIncome - currentThreshold);

  const totalNormal = basicTaxAfterRebate + normalSurcharge;
  if (totalNormal > cap) {
    return Math.max(0, cap - basicTaxAfterRebate);
  }
  return normalSurcharge;
}

// ---- MASTER: total tax (basic + surcharge + 4% cess) ----
// This is what every scenario calculation calls.
function computeTax(taxableIncome, regime) {
  if (taxableIncome <= 0) return 0;
  const basic = computeSlabTax(taxableIncome, regime);
  const afterRebate = applyRebate(basic, taxableIncome, regime);
  const surcharge = computeSurcharge(afterRebate, taxableIncome, regime);
  // 4% Health & Education Cess on (tax after rebate + surcharge)
  const withCess = (afterRebate + surcharge) * 1.04;
  return Math.round(withCess);
}

// Debug/transparency helper: returns every layer of the computation
// so the UI can show a full tax-breakdown panel to the user.
function computeTaxBreakdown(taxableIncome, regime) {
  if (taxableIncome <= 0) {
    return { basic: 0, rebate: 0, afterRebate: 0, surcharge: 0, cess: 0, total: 0 };
  }
  const basic = computeSlabTax(taxableIncome, regime);
  const afterRebate = applyRebate(basic, taxableIncome, regime);
  const rebate = basic - afterRebate;
  const surcharge = computeSurcharge(afterRebate, taxableIncome, regime);
  const cess = (afterRebate + surcharge) * 0.04;
  const total = Math.round((afterRebate + surcharge) * 1.04);
  return {
    basic: Math.round(basic),
    rebate: Math.round(rebate),
    afterRebate: Math.round(afterRebate),
    surcharge: Math.round(surcharge),
    cess: Math.round(cess),
    total,
  };
}

// Total tax when gross salary has FBP utilized amount restructured out of taxable
function taxForScenario(gross, utilizedFBP, regime) {
  const stdDeduction = regime === 'NTR' ? 75000 : 50000;
  const taxable = Math.max(0, gross - utilizedFBP - stdDeduction);
  return computeTax(taxable, regime);
}

// ============================================================
// FBP COMPONENT CATALOG
// maxAnnual values per Zaggle PPT + Income-tax Rules, 2026
// ============================================================

const FBP_CATALOG = [
  { id: 'meal',     label: 'Meal Allowance',        maxAnnual: 105600, monthly: 8800, ntrEligible: true,  otrEligible: true,  note: '₹200/meal × 2 × 22 days' },
  { id: 'fuel',     label: 'Fuel / Car Maintenance', maxAnnual: 84000,  monthly: 7000, ntrEligible: true,  otrEligible: true,  note: 'Requires bills, own car' },
  { id: 'driver',   label: 'Driver\'s Salary',       maxAnnual: 36000,  monthly: 3000, ntrEligible: true,  otrEligible: true,  note: '₹3,000/mo new limit' },
  { id: 'telecom',  label: 'Telecom / Internet',     maxAnnual: 24000,  monthly: 2000, ntrEligible: true,  otrEligible: true,  note: 'Postpaid bills reqd' },
  { id: 'gift',     label: 'Gift Voucher',           maxAnnual: 15000,  monthly: 1250, ntrEligible: true,  otrEligible: true,  note: 'Annual cap, non-cash' },
  { id: 'books',    label: 'Books & Periodicals',    maxAnnual: 12000,  monthly: 1000, ntrEligible: false, otrEligible: true,  note: 'Sec 10(14) — OTR only' },
  { id: 'wellness', label: 'Wellness',               maxAnnual: 30000,  monthly: 2500, ntrEligible: false, otrEligible: true,  note: 'Uncertain under NTR' },
];

// ============================================================
// FORMATTING
// ============================================================

function formatINR(amount) {
  if (amount === 0) return '₹0';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(Math.round(amount));
}

function formatINRCompact(amount) {
  if (amount >= 10000000) return `₹${(amount / 10000000).toFixed(2)} Cr`;
  if (amount >= 100000)   return `₹${(amount / 100000).toFixed(2)} L`;
  if (amount >= 1000)     return `₹${(amount / 1000).toFixed(1)}K`;
  return `₹${amount}`;
}

// ============================================================
// VERDICT LOGIC
// ============================================================

function getVerdict(annualSavingBest, annualSavingAvg, grossSalary) {
  const savingPctOfGross = (annualSavingAvg / grossSalary) * 100;

  if (annualSavingBest < 2000) {
    return {
      tier: 'skip',
      heading: 'Skip the FBP',
      subtext: 'Your tax liability is already near zero under the Section 87A rebate. The FBP won\'t save you meaningful tax and only adds compliance overhead.',
      color: 'muted',
    };
  }
  if (annualSavingAvg < 10000) {
    return {
      tier: 'marginal',
      heading: 'Marginal benefit — decide on convenience',
      subtext: 'Savings are small. Opt in only if you value the cashless convenience of the Zaggle card for food/fuel spending; the tax angle alone doesn\'t justify the paperwork.',
      color: 'amber',
    };
  }
  if (annualSavingAvg < 40000) {
    return {
      tier: 'moderate',
      heading: 'Worth opting in',
      subtext: 'Solid tax savings on the categories you already spend on. Discipline in uploading bills and using the card will lock in these savings.',
      color: 'forest',
    };
  }
  if (annualSavingAvg < 80000) {
    return {
      tier: 'strong',
      heading: 'Strongly recommended',
      subtext: 'Substantial savings. Maximise the Section 17 components (meal, fuel, driver, telecom, gift). Treat the Zaggle card as your default for these expenses.',
      color: 'emerald',
    };
  }
  return {
    tier: 'maximum',
    heading: 'Absolutely opt in — sweet spot',
    subtext: 'Your income sits in the range where FBP restructuring can even push you under the ₹12 lakh Section 87A rebate threshold. The savings here are transformative.',
    color: 'crimson',
  };
}

// ============================================================
// MAIN COMPONENT
// ============================================================

export default function ZaggleFBPCalculator() {
  const [grossSalary, setGrossSalary] = useState(1500000);
  const [regime, setRegime] = useState('NTR');
  const [components, setComponents] = useState(() =>
    FBP_CATALOG.reduce((acc, c) => {
      // Default: enable the high-value NTR-friendly ones
      acc[c.id] = {
        enabled: ['meal', 'gift', 'telecom'].includes(c.id),
        annual: c.maxAnnual,
      };
      return acc;
    }, {})
  );

  // Compute the total eligible FBP based on regime
  const totalDeclaredFBP = useMemo(() => {
    return FBP_CATALOG.reduce((sum, c) => {
      if (!components[c.id].enabled) return sum;
      const eligible = regime === 'NTR' ? c.ntrEligible : c.otrEligible;
      if (!eligible) return sum; // declared but not tax-free in this regime
      return sum + components[c.id].annual;
    }, 0);
  }, [components, regime]);

  // Three scenarios: best = 100%, avg = 70%, worst = 30%
  // We also include the full tax breakdown (slab / rebate / surcharge / cess)
  // for each scenario so the user can see exactly how every rupee is computed.
  const scenarios = useMemo(() => {
    const utilizations = { best: 1.00, average: 0.70, worst: 0.30 };
    const stdDeduction = regime === 'NTR' ? 75000 : 50000;

    // Baseline: no FBP utilized, just standard deduction
    const baselineTaxable = Math.max(0, grossSalary - stdDeduction);
    const baselineBreakdown = computeTaxBreakdown(baselineTaxable, regime);
    const baselineTax = baselineBreakdown.total;
    const baselineInHand = grossSalary - baselineTax;

    const out = {
      baselineTax,
      baselineInHand,
      baselineTaxable,
      baselineBreakdown,
      stdDeduction,
    };
    Object.entries(utilizations).forEach(([key, u]) => {
      const utilized = totalDeclaredFBP * u;
      const taxable = Math.max(0, grossSalary - utilized - stdDeduction);
      const breakdown = computeTaxBreakdown(taxable, regime);
      const tax = breakdown.total;
      out[key] = {
        utilization: u,
        utilizedAmount: utilized,
        taxable,
        breakdown,
        tax,
        saving: baselineTax - tax,
        inHand: grossSalary - tax,
        monthlyGain: (baselineTax - tax) / 12,
      };
    });
    return out;
  }, [grossSalary, regime, totalDeclaredFBP]);

  const verdict = getVerdict(scenarios.best.saving, scenarios.average.saving, grossSalary);

  // Chart data — keep all four labels roughly the same length so recharts
  // doesn't silently hide any of them through its auto-collision detection.
  // "Worst (30% use)" was getting dropped because it was longer than the
  // others; standardising to "Worst (30%)" solves the layout problem.
  const chartData = [
    { name: 'Without FBP', tax: scenarios.baselineTax, inHand: scenarios.baselineInHand, fill: '#94847B' },
    { name: 'Worst (30%)', tax: scenarios.worst.tax,   inHand: scenarios.worst.inHand,   fill: '#C98A6B' },
    { name: 'Average (70%)', tax: scenarios.average.tax, inHand: scenarios.average.inHand, fill: '#B5533E' },
    { name: 'Best (100%)', tax: scenarios.best.tax,    inHand: scenarios.best.inHand,    fill: '#7A1F1B' },
  ];

  const toggleComponent = (id) => {
    setComponents(prev => ({ ...prev, [id]: { ...prev[id], enabled: !prev[id].enabled } }));
  };
  const setComponentAmount = (id, amount) => {
    const max = FBP_CATALOG.find(c => c.id === id).maxAnnual;
    setComponents(prev => ({ ...prev, [id]: { ...prev[id], annual: Math.min(Math.max(0, amount), max) } }));
  };

  const verdictColorMap = {
    muted:    { bg: '#F0EBE4', border: '#94847B', text: '#3A332E', accent: '#94847B' },
    amber:    { bg: '#FCF4E6', border: '#C18A2E', text: '#4A3516', accent: '#C18A2E' },
    forest:   { bg: '#EBF1EA', border: '#3F6B4A', text: '#203A27', accent: '#3F6B4A' },
    emerald:  { bg: '#E3EDE7', border: '#1F5A3A', text: '#0F2F1F', accent: '#1F5A3A' },
    crimson:  { bg: '#F5E4E1', border: '#7A1F1B', text: '#3D0F0D', accent: '#7A1F1B' },
  };
  const vColor = verdictColorMap[verdict.color];

  return (
    <div style={{ fontFamily: "'Instrument Sans', -apple-system, system-ui, sans-serif", backgroundColor: '#FAF5EE', color: '#1F1B17', minHeight: '100vh' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400&family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

        .display-serif { font-family: 'Fraunces', Georgia, serif; font-optical-sizing: auto; }
        .mono { font-family: 'JetBrains Mono', 'SF Mono', monospace; font-feature-settings: 'tnum'; }

        input[type="range"] {
          -webkit-appearance: none;
          background: transparent;
          width: 100%;
        }
        input[type="range"]::-webkit-slider-runnable-track {
          height: 3px;
          background: linear-gradient(to right, #7A1F1B var(--pct, 50%), #E8DFD2 var(--pct, 50%));
          border-radius: 2px;
        }
        input[type="range"]::-moz-range-track {
          height: 3px;
          background: #E8DFD2;
          border-radius: 2px;
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          height: 18px;
          width: 18px;
          border-radius: 50%;
          background: #7A1F1B;
          border: 2px solid #FAF5EE;
          cursor: pointer;
          margin-top: -8px;
          box-shadow: 0 2px 6px rgba(122, 31, 27, 0.3);
        }
        input[type="range"]::-moz-range-thumb {
          height: 18px;
          width: 18px;
          border-radius: 50%;
          background: #7A1F1B;
          border: 2px solid #FAF5EE;
          cursor: pointer;
        }

        input[type="number"]::-webkit-inner-spin-button,
        input[type="number"]::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }

        .checkbox-custom {
          appearance: none;
          width: 20px; height: 20px;
          border: 1.5px solid #94847B;
          border-radius: 4px;
          cursor: pointer;
          position: relative;
          flex-shrink: 0;
          background: #FAF5EE;
          transition: all 0.15s ease;
        }
        .checkbox-custom:checked {
          background: #7A1F1B;
          border-color: #7A1F1B;
        }
        .checkbox-custom:checked::after {
          content: '';
          position: absolute;
          left: 5px; top: 1px;
          width: 6px; height: 11px;
          border: solid #FAF5EE;
          border-width: 0 2px 2px 0;
          transform: rotate(45deg);
        }

        .regime-toggle button {
          transition: all 0.2s ease;
        }

        .component-row {
          transition: all 0.15s ease;
          border-left: 2px solid transparent;
        }
        .component-row.enabled {
          border-left-color: #7A1F1B;
          background: rgba(122, 31, 27, 0.03);
        }
        .component-row.ineligible {
          opacity: 0.5;
        }

        .scenario-card {
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        .scenario-card:hover {
          transform: translateY(-2px);
        }

        @keyframes fadein {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .fadein { animation: fadein 0.5s ease-out both; }
      `}</style>

      {/* HEADER */}
      <header style={{ borderBottom: '1px solid #E8DFD2', padding: '32px 40px 28px', background: 'linear-gradient(180deg, #FAF5EE 0%, #F5EDE0 100%)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '16px', marginBottom: '8px' }}>
            <span className="mono" style={{ fontSize: '11px', letterSpacing: '0.15em', color: '#7A1F1B', fontWeight: 500 }}>
              FY 2026-27 · INCOME-TAX RULES, 2026
            </span>
            <span style={{ flex: 1, height: '1px', background: '#E8DFD2' }}></span>
            <span className="mono" style={{ fontSize: '11px', color: '#94847B' }}>v1.0</span>
          </div>
          <h1 className="display-serif" style={{ fontSize: 'clamp(32px, 4.5vw, 54px)', fontWeight: 400, lineHeight: 1.02, margin: 0, letterSpacing: '-0.02em' }}>
            The Zaggle Flexi-Benefit <em style={{ color: '#7A1F1B', fontStyle: 'italic' }}>Calculator</em>
          </h1>
          <p style={{ marginTop: '14px', fontSize: '15px', color: '#5A5149', maxWidth: '680px', lineHeight: 1.5 }}>
            Model your tax savings from each FBP component under the New Tax Regime — and see the real impact on your in-hand salary across best, average, and worst-case utilization.
          </p>
        </div>
      </header>

      {/* MAIN GRID */}
      <main style={{ maxWidth: '1400px', margin: '0 auto', padding: '40px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 420px) 1fr', gap: '32px' }} className="main-grid">

          {/* ========== LEFT: INPUTS ========== */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

            {/* Salary input */}
            <div style={{ background: '#FFFFFF', padding: '24px', borderRadius: '4px', border: '1px solid #E8DFD2' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
                <label className="mono" style={{ fontSize: '11px', letterSpacing: '0.12em', color: '#7A1F1B', fontWeight: 500 }}>
                  STEP 01 — YOUR ANNUAL CTC
                </label>
              </div>
              <div style={{ marginBottom: '16px' }}>
                <div className="display-serif" style={{ fontSize: '36px', fontWeight: 500, color: '#1F1B17', letterSpacing: '-0.02em' }}>
                  {formatINR(grossSalary)}
                </div>
                <div style={{ fontSize: '13px', color: '#7A6B5F', marginTop: '2px' }}>
                  {formatINRCompact(grossSalary / 12)} per month · {formatINRCompact(grossSalary)} annual
                </div>
              </div>
              <input
                type="range"
                min={300000}
                max={10000000}
                step={50000}
                value={grossSalary}
                onChange={(e) => setGrossSalary(Number(e.target.value))}
                style={{ '--pct': `${((grossSalary - 300000) / (10000000 - 300000)) * 100}%` }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '11px', color: '#94847B' }}>
                <span>₹3 L</span>
                <span>₹1 Cr</span>
              </div>
              <div style={{ marginTop: '16px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {[600000, 1200000, 1800000, 2500000, 4000000].map(v => (
                  <button
                    key={v}
                    onClick={() => setGrossSalary(v)}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      background: grossSalary === v ? '#7A1F1B' : 'transparent',
                      color: grossSalary === v ? '#FAF5EE' : '#5A5149',
                      border: '1px solid',
                      borderColor: grossSalary === v ? '#7A1F1B' : '#D4C7B6',
                      borderRadius: '2px',
                      cursor: 'pointer',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    {formatINRCompact(v)}
                  </button>
                ))}
              </div>
            </div>

            {/* Regime toggle */}
            <div style={{ background: '#FFFFFF', padding: '24px', borderRadius: '4px', border: '1px solid #E8DFD2' }}>
              <label className="mono" style={{ fontSize: '11px', letterSpacing: '0.12em', color: '#7A1F1B', fontWeight: 500, display: 'block', marginBottom: '14px' }}>
                STEP 02 — TAX REGIME
              </label>
              <div className="regime-toggle" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                {['NTR', 'OTR'].map(r => (
                  <button
                    key={r}
                    onClick={() => setRegime(r)}
                    style={{
                      padding: '14px 12px',
                      background: regime === r ? '#1F1B17' : 'transparent',
                      color: regime === r ? '#FAF5EE' : '#5A5149',
                      border: '1px solid',
                      borderColor: regime === r ? '#1F1B17' : '#D4C7B6',
                      borderRadius: '2px',
                      cursor: 'pointer',
                      textAlign: 'left',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '2px',
                    }}
                  >
                    <span className="display-serif" style={{ fontSize: '18px', fontWeight: 500 }}>
                      {r === 'NTR' ? 'New Regime' : 'Old Regime'}
                    </span>
                    <span className="mono" style={{ fontSize: '10px', opacity: 0.8 }}>
                      {r === 'NTR' ? 'Sec 115BAC · default' : 'Sec 10 & 80C intact'}
                    </span>
                  </button>
                ))}
              </div>
              <p style={{ marginTop: '12px', fontSize: '12px', color: '#7A6B5F', lineHeight: 1.5 }}>
                {regime === 'NTR'
                  ? 'Under NTR, only Section 17 perquisite-based wallets are tax-free. Books & Wellness lose their status.'
                  : 'Under OTR, all seven FBP wallets retain their tax-free status — but you lose the higher slab thresholds of NTR.'}
              </p>
            </div>

            {/* FBP Components */}
            <div style={{ background: '#FFFFFF', padding: '24px', borderRadius: '4px', border: '1px solid #E8DFD2' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '16px' }}>
                <label className="mono" style={{ fontSize: '11px', letterSpacing: '0.12em', color: '#7A1F1B', fontWeight: 500 }}>
                  STEP 03 — CHOOSE COMPONENTS
                </label>
                <span className="mono" style={{ fontSize: '11px', color: '#94847B' }}>
                  {FBP_CATALOG.filter(c => components[c.id].enabled).length} of {FBP_CATALOG.length} selected
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {FBP_CATALOG.map(c => {
                  const eligible = regime === 'NTR' ? c.ntrEligible : c.otrEligible;
                  const isOn = components[c.id].enabled;
                  return (
                    <div
                      key={c.id}
                      className={`component-row ${isOn ? 'enabled' : ''} ${!eligible ? 'ineligible' : ''}`}
                      style={{ padding: '14px 12px', borderBottom: '1px solid #F0EBE4' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                        <input
                          type="checkbox"
                          className="checkbox-custom"
                          checked={isOn}
                          onChange={() => toggleComponent(c.id)}
                          style={{ marginTop: '2px' }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                            <span style={{ fontSize: '14px', fontWeight: 500, color: '#1F1B17' }}>{c.label}</span>
                            <span className="mono" style={{ fontSize: '12px', color: eligible ? '#3F6B4A' : '#B5533E', fontWeight: 500, whiteSpace: 'nowrap' }}>
                              {eligible ? '✓ tax-free' : '✗ taxable'}
                            </span>
                          </div>
                          <div style={{ fontSize: '11px', color: '#94847B', marginTop: '2px', fontStyle: 'italic' }}>
                            {c.note}
                          </div>
                          {isOn && eligible && (
                            <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }} className="fadein">
                              <input
                                type="number"
                                value={components[c.id].annual}
                                onChange={(e) => setComponentAmount(c.id, Number(e.target.value))}
                                max={c.maxAnnual}
                                min={0}
                                step={1000}
                                style={{
                                  width: '110px',
                                  padding: '6px 10px',
                                  border: '1px solid #D4C7B6',
                                  borderRadius: '2px',
                                  fontSize: '13px',
                                  fontFamily: "'JetBrains Mono', monospace",
                                  background: '#FAF5EE',
                                  color: '#1F1B17',
                                }}
                              />
                              <span style={{ fontSize: '11px', color: '#7A6B5F' }}>
                                of max {formatINRCompact(c.maxAnnual)} · {formatINRCompact(components[c.id].annual / 12)}/mo
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ marginTop: '16px', padding: '12px 14px', background: '#F5EDE0', borderRadius: '2px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: '12px', color: '#5A5149', fontWeight: 500 }}>Total tax-free declared under {regime}</span>
                <span className="mono display-serif" style={{ fontSize: '18px', fontWeight: 500, color: '#7A1F1B' }}>
                  {formatINR(totalDeclaredFBP)}
                </span>
              </div>
            </div>
          </section>

          {/* ========== RIGHT: RESULTS ========== */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

            {/* Baseline vs best case hero */}
            <div style={{ background: '#1F1B17', color: '#FAF5EE', padding: '32px', borderRadius: '4px', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: 0, right: 0, width: '40%', height: '100%', background: 'linear-gradient(135deg, transparent 40%, rgba(122, 31, 27, 0.25) 100%)', pointerEvents: 'none' }}></div>
              <div style={{ position: 'relative', zIndex: 1 }}>
                <div className="mono" style={{ fontSize: '11px', letterSpacing: '0.15em', color: '#C98A6B', fontWeight: 500, marginBottom: '20px' }}>
                  HEADLINE IMPACT — {regime}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '24px' }}>
                  <div>
                    <div style={{ fontSize: '11px', color: '#B5A99B', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      Tax without FBP
                    </div>
                    <div className="display-serif" style={{ fontSize: '26px', fontWeight: 400, letterSpacing: '-0.02em' }}>
                      {formatINR(scenarios.baselineTax)}
                    </div>
                    <div className="mono" style={{ fontSize: '11px', color: '#B5A99B', marginTop: '2px' }}>
                      {((scenarios.baselineTax / grossSalary) * 100).toFixed(1)}% of gross
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: '#B5A99B', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      Best-case saving
                    </div>
                    <div className="display-serif" style={{ fontSize: '26px', fontWeight: 400, color: '#F5B584', letterSpacing: '-0.02em' }}>
                      {formatINR(scenarios.best.saving)}
                    </div>
                    <div className="mono" style={{ fontSize: '11px', color: '#B5A99B', marginTop: '2px' }}>
                      per year
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: '#B5A99B', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      Extra post-tax/mo
                    </div>
                    <div className="display-serif" style={{ fontSize: '26px', fontWeight: 400, color: '#F5B584', letterSpacing: '-0.02em' }}>
                      {formatINR(scenarios.best.monthlyGain)}
                    </div>
                    <div className="mono" style={{ fontSize: '11px', color: '#B5A99B', marginTop: '2px' }}>
                      at 100% use
                    </div>
                  </div>
                </div>

                {/*
                  Transparent tax breakdown strip — shows every layer of the
                  baseline (no-FBP) tax computation so the user can verify
                  the math. Reads left-to-right:
                  slab tax → minus rebate → plus surcharge → plus cess → total.
                  Zero components (e.g. surcharge for < ₹50L) are rendered
                  but muted, so the structure is always the same.
                */}
                <div style={{ marginTop: '24px', paddingTop: '18px', borderTop: '1px solid rgba(245, 181, 132, 0.2)' }}>
                  <div className="mono" style={{ fontSize: '10px', letterSpacing: '0.12em', color: '#F5B584', fontWeight: 500, marginBottom: '10px' }}>
                    HOW THIS TAX IS COMPUTED (BASELINE, NO FBP)
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 0', alignItems: 'baseline', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }}>
                    {/* Step 1: slab tax */}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                      <span style={{ color: '#B5A99B' }}>Slab</span>
                      <span style={{ color: '#FAF5EE', fontWeight: 500 }}>
                        {formatINR(scenarios.baselineBreakdown.basic)}
                      </span>
                    </div>

                    {/* Step 2: rebate (shown as subtraction) */}
                    {scenarios.baselineBreakdown.rebate > 0 && (
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginLeft: '12px' }}>
                        <span style={{ color: '#B5A99B' }}>−</span>
                        <span style={{ color: '#B5A99B' }}>Rebate 87A</span>
                        <span style={{ color: '#7FD99A', fontWeight: 500 }}>
                          {formatINR(scenarios.baselineBreakdown.rebate)}
                        </span>
                      </div>
                    )}

                    {/* Step 3: surcharge (only if > 0) */}
                    {scenarios.baselineBreakdown.surcharge > 0 && (
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginLeft: '12px' }}>
                        <span style={{ color: '#B5A99B' }}>+</span>
                        <span style={{ color: '#B5A99B' }}>Surcharge</span>
                        <span style={{ color: '#F5B584', fontWeight: 500 }}>
                          {formatINR(scenarios.baselineBreakdown.surcharge)}
                        </span>
                      </div>
                    )}

                    {/* Step 4: cess */}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginLeft: '12px' }}>
                      <span style={{ color: '#B5A99B' }}>+</span>
                      <span style={{ color: '#B5A99B' }}>4% Cess</span>
                      <span style={{ color: '#F5B584', fontWeight: 500 }}>
                        {formatINR(scenarios.baselineBreakdown.cess)}
                      </span>
                    </div>

                    {/* Step 5: total */}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginLeft: 'auto' }}>
                      <span style={{ color: '#B5A99B' }}>=</span>
                      <span style={{ color: '#FAF5EE', fontWeight: 700 }}>
                        {formatINR(scenarios.baselineBreakdown.total)}
                      </span>
                    </div>
                  </div>

                  {/*
                    Contextual helper line — explains why a zero might appear
                    where the user might expect a number (e.g. surcharge at
                    lower incomes, rebate above ₹12L, or the marginal-relief
                    band just above ₹12L).
                  */}
                  <div style={{ marginTop: '10px', fontSize: '11px', color: '#94847B', lineHeight: 1.5, fontStyle: 'italic' }}>
                    {scenarios.baselineTaxable <= 0
                      ? 'Taxable income is zero — your gross is below the standard deduction.'
                      : scenarios.baselineTaxable <= 1200000 && regime === 'NTR'
                      ? `Section 87A rebate of ₹60,000 fully offsets your ₹${formatINR(scenarios.baselineBreakdown.basic)} slab tax. Taxable income: ${formatINR(scenarios.baselineTaxable)}.`
                      : scenarios.baselineTaxable > 1200000 && scenarios.baselineTaxable < 1271000 && regime === 'NTR'
                      ? `Marginal relief applies — your tax is capped at the amount by which taxable income exceeds ₹12L (${formatINR(scenarios.baselineTaxable - 1200000)}).`
                      : scenarios.baselineTaxable > 5000000
                      ? `Surcharge applies because taxable income (${formatINR(scenarios.baselineTaxable)}) exceeds ₹50L. Marginal relief caps the jump at the threshold.`
                      : `Standard deduction of ${formatINR(scenarios.stdDeduction)} applied. Taxable income: ${formatINR(scenarios.baselineTaxable)}.`}
                  </div>
                </div>
              </div>
            </div>

            {/* Three scenario cards */}
            <div>
              <h2 className="display-serif" style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 16px', letterSpacing: '-0.01em' }}>
                Scenario analysis <span style={{ color: '#94847B', fontSize: '14px', fontWeight: 400, fontStyle: 'italic' }}>— by how disciplined you'll actually be</span>
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
                {[
                  { key: 'worst',   label: 'Worst case',   pct: '30% utilization', desc: 'Card barely used', accent: '#C98A6B' },
                  { key: 'average', label: 'Average case', pct: '70% utilization', desc: 'Typical engagement', accent: '#B5533E' },
                  { key: 'best',    label: 'Best case',    pct: '100% utilization', desc: 'Full discipline', accent: '#7A1F1B' },
                ].map(s => {
                  const d = scenarios[s.key];
                  return (
                    <div key={s.key} className="scenario-card" style={{ background: '#FFFFFF', padding: '20px', borderRadius: '4px', border: '1px solid #E8DFD2', borderTop: `3px solid ${s.accent}` }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: s.accent }}>{s.label}</div>
                      <div className="mono" style={{ fontSize: '10px', color: '#94847B', marginTop: '2px' }}>{s.pct} · {s.desc}</div>
                      <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #F0EBE4' }}>
                        <div style={{ fontSize: '11px', color: '#7A6B5F', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Tax due</div>
                        <div className="mono" style={{ fontSize: '16px', fontWeight: 500, color: '#1F1B17', marginTop: '2px' }}>
                          {formatINR(d.tax)}
                        </div>
                      </div>
                      <div style={{ marginTop: '10px' }}>
                        <div style={{ fontSize: '11px', color: '#7A6B5F', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Annual saving</div>
                        <div className="display-serif" style={{ fontSize: '22px', fontWeight: 500, color: s.accent, letterSpacing: '-0.01em' }}>
                          {formatINR(d.saving)}
                        </div>
                      </div>
                      <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <span style={{ fontSize: '11px', color: '#7A6B5F' }}>per month</span>
                        <span className="mono" style={{ fontSize: '13px', fontWeight: 500, color: '#1F1B17' }}>+{formatINR(d.monthlyGain)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Chart */}
            <div style={{ background: '#FFFFFF', padding: '24px', borderRadius: '4px', border: '1px solid #E8DFD2' }}>
              <h3 className="display-serif" style={{ fontSize: '18px', fontWeight: 500, margin: '0 0 4px' }}>
                In-hand pay by scenario
              </h3>
              <p style={{ fontSize: '12px', color: '#7A6B5F', margin: '0 0 20px' }}>
                Gross salary minus tax across all four outcomes. Y-axis is zoomed in so the differences are visible — the absolute heights aren't to scale from zero.
              </p>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={chartData} margin={{ top: 30, right: 20, left: 20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="#E8DFD2" vertical={false} />
                  <XAxis
                    dataKey="name"
                    // interval={0} is the explicit opt-out from recharts'
                    // auto-hide-overlapping-labels behaviour. Without this,
                    // the library silently drops labels it thinks will
                    // collide, which can leave a nameless bar — confusing
                    // to the reader. We'd rather guarantee all four show.
                    interval={0}
                    tick={{ fill: '#5A5149', fontSize: 11, fontFamily: "'Instrument Sans', sans-serif" }}
                    axisLine={{ stroke: '#D4C7B6' }}
                    tickLine={false}
                  />
                  {/*
                    Key fix: dynamic Y-axis domain. Instead of starting at 0 (which
                    crushes the visible differences), we zoom into roughly 98.5% of
                    the minimum value up to the maximum. This magnifies the variance
                    between scenarios so the savings are actually legible.
                  */}
                  <YAxis
                    domain={[
                      (dataMin) => Math.floor((dataMin * 0.985) / 10000) * 10000,
                      (dataMax) => Math.ceil((dataMax * 1.003) / 10000) * 10000,
                    ]}
                    tick={{ fill: '#5A5149', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}
                    axisLine={{ stroke: '#D4C7B6' }}
                    tickLine={false}
                    tickFormatter={(v) => formatINRCompact(v)}
                    width={70}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1F1B17',
                      border: 'none',
                      borderRadius: '2px',
                      color: '#FAF5EE',
                      fontSize: '12px',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                    labelStyle={{ color: '#F5B584' }}
                    formatter={(v) => formatINR(v)}
                    cursor={{ fill: 'rgba(122, 31, 27, 0.06)' }}
                  />
                  <Bar dataKey="inHand" name="In-hand" radius={[2, 2, 0, 0]}>
                    {/*
                      LabelList puts the exact in-hand figure on top of each bar
                      so the user doesn't have to hover to read the values.
                    */}
                    <LabelList
                      dataKey="inHand"
                      position="top"
                      formatter={(v) => formatINRCompact(v)}
                      style={{
                        fill: '#1F1B17',
                        fontSize: 11,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 600,
                      }}
                    />
                    {chartData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {/*
                Small legend / caption explaining the zoom, plus a quick sanity
                anchor showing the baseline so the reader can mentally size up
                the deltas against it.
              */}
              <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #F0EBE4', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontSize: '10px', color: '#94847B', letterSpacing: '0.06em' }}>
                  BASELINE IN-HAND (NO FBP) · {formatINR(scenarios.baselineInHand)}
                </span>
                <span className="mono" style={{ fontSize: '10px', color: '#7A1F1B', letterSpacing: '0.06em', fontWeight: 600 }}>
                  MAX GAIN · +{formatINR(scenarios.best.saving)}
                </span>
              </div>
            </div>

            {/* Verdict */}
            <div
              style={{
                background: vColor.bg,
                border: `1px solid ${vColor.border}`,
                borderLeft: `4px solid ${vColor.border}`,
                padding: '28px',
                borderRadius: '4px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px', gap: '16px' }}>
                <div>
                  <div className="mono" style={{ fontSize: '11px', letterSpacing: '0.15em', color: vColor.accent, fontWeight: 600, marginBottom: '6px' }}>
                    FINAL VERDICT
                  </div>
                  <h2 className="display-serif" style={{ fontSize: '28px', fontWeight: 500, margin: 0, color: vColor.text, letterSpacing: '-0.02em', lineHeight: 1.15 }}>
                    {verdict.heading}
                  </h2>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div className="mono" style={{ fontSize: '10px', color: vColor.accent, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Avg-case saving</div>
                  <div className="display-serif" style={{ fontSize: '26px', fontWeight: 500, color: vColor.text, letterSpacing: '-0.01em' }}>
                    {formatINR(scenarios.average.saving)}
                  </div>
                  <div style={{ fontSize: '11px', color: vColor.accent }}>per year</div>
                </div>
              </div>
              <p style={{ fontSize: '14px', lineHeight: 1.6, color: vColor.text, margin: 0, opacity: 0.9 }}>
                {verdict.subtext}
              </p>

              {/* Summary stats */}
              <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: `1px solid ${vColor.border}40`, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
                <div>
                  <div className="mono" style={{ fontSize: '10px', color: vColor.accent, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Worst case</div>
                  <div className="mono" style={{ fontSize: '15px', fontWeight: 500, color: vColor.text, marginTop: '2px' }}>
                    +{formatINR(scenarios.worst.saving)}/yr
                  </div>
                  <div style={{ fontSize: '11px', color: vColor.accent, marginTop: '1px' }}>
                    +{formatINR(scenarios.worst.monthlyGain)}/mo
                  </div>
                </div>
                <div>
                  <div className="mono" style={{ fontSize: '10px', color: vColor.accent, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Average case</div>
                  <div className="mono" style={{ fontSize: '15px', fontWeight: 500, color: vColor.text, marginTop: '2px' }}>
                    +{formatINR(scenarios.average.saving)}/yr
                  </div>
                  <div style={{ fontSize: '11px', color: vColor.accent, marginTop: '1px' }}>
                    +{formatINR(scenarios.average.monthlyGain)}/mo
                  </div>
                </div>
                <div>
                  <div className="mono" style={{ fontSize: '10px', color: vColor.accent, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Best case</div>
                  <div className="mono" style={{ fontSize: '15px', fontWeight: 500, color: vColor.text, marginTop: '2px' }}>
                    +{formatINR(scenarios.best.saving)}/yr
                  </div>
                  <div style={{ fontSize: '11px', color: vColor.accent, marginTop: '1px' }}>
                    +{formatINR(scenarios.best.monthlyGain)}/mo
                  </div>
                </div>
              </div>
            </div>

            {/* Disclosure */}
            <div style={{ fontSize: '11px', color: '#94847B', lineHeight: 1.6, fontStyle: 'italic', padding: '0 4px' }}>
              Calculator implements the FY 2026-27 tax regime in four layers: (1) slab tax on taxable income per Budget 2025 rates, (2) Section 87A rebate of ₹60,000 up to ₹12L taxable income with marginal relief in the ₹12L–₹12.71L band (NTR) / ₹12,500 up to ₹5L (OTR), (3) surcharge of 10%/15%/25% for income above ₹50L/₹1Cr/₹2Cr with marginal relief at each threshold (NTR caps at 25%; OTR has a 37% bracket above ₹5Cr), and (4) 4% Health &amp; Education Cess. Standard deduction of ₹75,000 (NTR) / ₹50,000 (OTR) is applied. Component caps are per the Income-tax Rules, 2026 notified 20 March 2026. "Post-tax pay" means gross salary minus income tax only; it does not subtract EPF (12% of basic, typically capped ≈₹21,600/yr), professional tax (₹2,400–₹2,500/yr depending on state), or other voluntary deductions — those reduce bank-credit in-hand by the same amount in every scenario and don't affect the relative comparison. "Utilization" models real-world bill-upload and card-swipe discipline. Every figure above rounds to the nearest rupee. This is planning guidance, not personal tax advice — consult a CA before locking in your FBP declaration.
            </div>
          </section>
        </div>

        <style>{`
          @media (max-width: 900px) {
            .main-grid { grid-template-columns: 1fr !important; }
          }
          @media (max-width: 600px) {
            main { padding: 20px !important; }
            header { padding: 24px 20px !important; }
          }
        `}</style>
      </main>
    </div>
  );
}
