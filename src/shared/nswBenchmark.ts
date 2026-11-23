import type {
  BenchmarkReportRecord,
  BenchmarkReportSectionSnapshot,
  MarkingResult,
  QuestionItem,
  SectionCode,
  SessionRecord,
  StudentQuestionView,
  WritingEvaluationRecord,
} from './contracts.ts';

export type SchoolGenderType = 'coed' | 'boys' | 'girls';
export type ApplicantGenderFilter = 'all' | 'girls' | 'boys';
export type BenchmarkDifficultyPreset =
  | 'official_sample'
  | 'real_exam'
  | 'selective_lab_timed'
  | 'selective_lab_hard';
export type BenchmarkWeightingMode = 'official_2025_equal' | 'legacy_2021_2024';
export type NswPerformanceBand = 'top_10' | 'next_15' | 'next_25' | 'lowest_50';
export type SchoolOfferStatus =
  | 'likely_offer'
  | 'borderline_offer'
  | 'reserve_range'
  | 'reach'
  | 'below';

export interface NswSelectiveSchoolSpec {
  id: string;
  name: string;
  shortName: string;
  region: string;
  gender: SchoolGenderType;
  /** Published Year 7 intake places (all places, before equity reserve). */
  totalSpots: number;
  boysSpots: number;
  girlsSpots: number;
  /** General-merit share after the NSW 20% Equity Placement Model (~0.80). */
  generalShare: number;
  /** Recent HSC academic ranking (for context only — NOT equal to Year 7 entry cutoff). */
  hscRankRecent: number;
  /** Estimated General-Pool First-Round Offer cutoff on the familiar /120 scaled score. */
  firstRoundCutoff120: number;
  /** Estimated General-Pool Reserve-List final offer cutoff on /120. */
  reserveCutoff120: number;
  /** Brief domain rationale (spots, corridor demand, HSC vs entry dynamics). */
  note: string;
}

export interface BenchmarkSectionInput {
  /** Earned slots or marks (e.g. Reading /38, Maths /35, Thinking /40, Writing /20). */
  score: number;
  /** Maximum possible slots or marks for this section. */
  maxScore: number;
}

export interface BenchmarkScoreInput {
  read: BenchmarkSectionInput;
  math: BenchmarkSectionInput;
  think: BenchmarkSectionInput;
  writ: BenchmarkSectionInput;
  difficulty: BenchmarkDifficultyPreset;
  weighting?: BenchmarkWeightingMode;
  genderFilter?: ApplicantGenderFilter;
}

export interface BenchmarkSectionEvaluation {
  section: SectionCode;
  score: number;
  maxScore: number;
  rawPct: number;
  weight: number;
  zScore: number;
  estimatedPercentile: number;
  band: NswPerformanceBand;
}

export interface SchoolCutoffEstimate {
  school: NswSelectiveSchoolSpec;
  eligibleSpots: number;
  estimatedGeneralSpots: number;
  firstRoundCutoff120: number;
  reserveCutoff120: number;
  /** Approximate uniform raw % across the 4 components at the active difficulty preset to hit First-Round cutoff. */
  equivalentRawPctNeeded: number;
  /** Student's scaled score minus school's estimated First-Round cutoff. */
  deltaFromFirstRound: number;
  /** Student's scaled score minus school's estimated Reserve-List cutoff. */
  deltaFromReserve: number;
  status: SchoolOfferStatus;
}

export interface BenchmarkLeverageTip {
  section: SectionCode;
  delta: number;
  incrementLabel: string;
  scaledGain120: number;
  unlockedSchools: string[];
}

export interface NswBenchmarkReport {
  scaledScore120: number;
  scaledScore100: number;
  uncertaintyHalfWidth120: number;
  compositeZ: number;
  estimatedPercentile: number;
  estimatedStateRank: number;
  estimatedApplicantPool: number;
  difficulty: BenchmarkDifficultyPreset;
  weighting: BenchmarkWeightingMode;
  genderFilter: ApplicantGenderFilter;
  sections: Record<SectionCode, BenchmarkSectionEvaluation>;
  schools: SchoolCutoffEstimate[];
  countsByStatus: Record<SchoolOfferStatus, number>;
  highestLeverage: BenchmarkLeverageTip | null;
}

export const ESTIMATED_NSW_APPLICANTS = 18_000;
export const BENCHMARK_UNCERTAINTY_HALF_WIDTH_120 = 2.5;

export const OFFICIAL_SECTION_MAX_MARKS: Record<SectionCode, number> = {
  READ: 38,
  MATH: 35,
  THINK: 40,
  WRIT: 20,
};

export const BENCHMARK_WEIGHTINGS: Record<BenchmarkWeightingMode, Record<SectionCode, number>> = {
  // 2025+ computer-based NSW Selective High School Placement Test: 4 equal 25% components
  official_2025_equal: { READ: 0.25, MATH: 0.25, THINK: 0.25, WRIT: 0.25 },
  // Legacy 2021–2024 Cambridge weighting
  legacy_2021_2024: { READ: 0.25, MATH: 0.25, THINK: 0.35, WRIT: 0.15 },
};

interface DifficultyCalibrationSpec {
  id: BenchmarkDifficultyPreset;
  /** Mean & SD (%) of the ~18,000 applicant cohort on a test of this difficulty & timing. */
  cohortMeanPct: Record<SectionCode, number>;
  cohortSdPct: Record<SectionCode, number>;
}

/**
 * Psychometric cohort baselines calibrated so realistic scores map cleanly:
 * - Official DoE samples (avg_diff ~2.9) sit softer than real exam day.
 * - Real NSW exam day has tighter time pressure (45m Read / 40m Math / 40m Think / 30m Writ).
 * - Selective Lab timed (~4.4 diff, exact 40m/40m budgets like b17) & hard (~4.8 diff, like b06)
 *   shift objective means down realistically (time + 3-step depth) while Writing stays criterion-referenced /20.
 */
export const DIFFICULTY_CALIBRATION: Record<BenchmarkDifficultyPreset, DifficultyCalibrationSpec> = {
  official_sample: {
    id: 'official_sample',
    cohortMeanPct: { READ: 68, MATH: 62, THINK: 62, WRIT: 57.5 },
    cohortSdPct: { READ: 14.0, MATH: 16.0, THINK: 15.0, WRIT: 14.0 },
  },
  real_exam: {
    id: 'real_exam',
    cohortMeanPct: { READ: 63, MATH: 55, THINK: 56, WRIT: 57.5 },
    cohortSdPct: { READ: 14.5, MATH: 16.5, THINK: 15.5, WRIT: 14.0 },
  },
  selective_lab_timed: {
    id: 'selective_lab_timed',
    cohortMeanPct: { READ: 57, MATH: 48, THINK: 49, WRIT: 57.5 },
    cohortSdPct: { READ: 14.5, MATH: 16.5, THINK: 15.5, WRIT: 14.0 },
  },
  selective_lab_hard: {
    id: 'selective_lab_hard',
    cohortMeanPct: { READ: 55, MATH: 45, THINK: 46, WRIT: 57.5 },
    cohortSdPct: { READ: 14.5, MATH: 16.5, THINK: 15.5, WRIT: 14.0 },
  },
};

/**
 * All 18 major day-entry NSW Fully Selective High Schools.
 * - Spots follow published Year 7 intakes + DoE Equal-Access 50/50 co-ed split.
 * - General-merit capacity reflects the NSW 20% Equity Placement Model (~80% general pool).
 * - Cutoffs are personal analytical estimates on the familiar /120 scale (combining published
 *   spot scarcity, historical 2020–2025 cutoff bands, corridor demand, and recent HSC rankings).
 *   Notice how spot count + gender pool explains overlaps like Baulko (180 co-ed: 90B/90G) vs
 *   Hornsby Girls (120 girls-only) and North Sydney Boys (150 boys) vs James Ruse (120 co-ed).
 */
export const NSW_FULLY_SELECTIVE_SCHOOLS: readonly NswSelectiveSchoolSpec[] = [
  {
    id: 'james_ruse',
    name: 'James Ruse Agricultural High School',
    shortName: 'James Ruse',
    region: 'Carlingford',
    gender: 'coed',
    totalSpots: 120,
    boysSpots: 60,
    girlsSpots: 60,
    generalShare: 0.8,
    hscRankRecent: 2,
    firstRoundCutoff120: 107.5,
    reserveCutoff120: 105.0,
    note: 'Smallest top-tier co-ed intake (~48 general spots per gender); historically highest cutoff in NSW.',
  },
  {
    id: 'north_sydney_boys',
    name: 'North Sydney Boys High School',
    shortName: 'North Sydney Boys',
    region: 'Crows Nest',
    gender: 'boys',
    totalSpots: 150,
    boysSpots: 150,
    girlsSpots: 0,
    generalShare: 0.8,
    hscRankRecent: 1,
    firstRoundCutoff120: 104.5,
    reserveCutoff120: 101.5,
    note: 'Recent #1 HSC momentum keeps demand very tight (~120 general boys spots).',
  },
  {
    id: 'baulkham_hills',
    name: 'Baulkham Hills High School',
    shortName: 'Baulko',
    region: 'Baulkham Hills',
    gender: 'coed',
    totalSpots: 180,
    boysSpots: 90,
    girlsSpots: 90,
    generalShare: 0.8,
    hscRankRecent: 3,
    firstRoundCutoff120: 103.5,
    reserveCutoff120: 100.5,
    note: 'Large 180-spot Hills intake (~72 general per gender); high HSC rank but larger pool creates slight overlap with smaller single-sex North Shore schools.',
  },
  {
    id: 'north_sydney_girls',
    name: 'North Sydney Girls High School',
    shortName: 'North Sydney Girls',
    region: 'Crows Nest',
    gender: 'girls',
    totalSpots: 150,
    boysSpots: 0,
    girlsSpots: 150,
    generalShare: 0.8,
    hscRankRecent: 4,
    firstRoundCutoff120: 103.0,
    reserveCutoff120: 100.0,
    note: 'Highest single-sex girls cutoff (~120 general girls spots); closely tracks Baulkham Hills.',
  },
  {
    id: 'hornsby_girls',
    name: 'Hornsby Girls High School',
    shortName: 'Hornsby Girls',
    region: 'Hornsby',
    gender: 'girls',
    totalSpots: 120,
    boysSpots: 0,
    girlsSpots: 120,
    generalShare: 0.8,
    hscRankRecent: 8,
    firstRoundCutoff120: 101.0,
    reserveCutoff120: 98.0,
    note: 'Compact 120-spot Upper North Shore intake (~96 general girls spots) pushes entry cutoff higher than its HSC rank alone suggests.',
  },
  {
    id: 'sydney_girls',
    name: 'Sydney Girls High School',
    shortName: 'Sydney Girls',
    region: 'Surry Hills',
    gender: 'girls',
    totalSpots: 150,
    boysSpots: 0,
    girlsSpots: 150,
    generalShare: 0.8,
    hscRankRecent: 6,
    firstRoundCutoff120: 100.5,
    reserveCutoff120: 97.5,
    note: 'Strong inner-Sydney girls demand (~120 general spots); tightly clustered with Hornsby Girls.',
  },
  {
    id: 'sydney_boys',
    name: 'Sydney Boys High School',
    shortName: 'Sydney Boys',
    region: 'Moore Park',
    gender: 'boys',
    totalSpots: 180,
    boysSpots: 180,
    girlsSpots: 0,
    generalShare: 0.8,
    hscRankRecent: 7,
    firstRoundCutoff120: 100.0,
    reserveCutoff120: 97.0,
    note: 'Larger 180-spot boys intake (~144 general spots) softens cutoff slightly relative to North Sydney Boys.',
  },
  {
    id: 'normanhurst_boys',
    name: 'Normanhurst Boys High School',
    shortName: 'Normanhurst Boys',
    region: 'Normanhurst',
    gender: 'boys',
    totalSpots: 120,
    boysSpots: 120,
    girlsSpots: 0,
    generalShare: 0.8,
    hscRankRecent: 5,
    firstRoundCutoff120: 99.5,
    reserveCutoff120: 96.5,
    note: 'Compact 120-spot intake (~96 general boys spots) + top-5 HSC rise keeps entry competitive.',
  },
  {
    id: 'fort_street',
    name: 'Fort Street High School',
    shortName: 'Fort Street',
    region: 'Petersham',
    gender: 'coed',
    totalSpots: 150,
    boysSpots: 75,
    girlsSpots: 75,
    generalShare: 0.8,
    hscRankRecent: 9,
    firstRoundCutoff120: 98.0,
    reserveCutoff120: 95.0,
    note: 'Popular Inner West co-ed option (~60 general spots per gender); steady reserve-list movement.',
  },
  {
    id: 'girraween',
    name: 'Girraween High School',
    shortName: 'Girraween',
    region: 'Girraween',
    gender: 'coed',
    totalSpots: 120,
    boysSpots: 60,
    girlsSpots: 60,
    generalShare: 0.8,
    hscRankRecent: 11,
    firstRoundCutoff120: 97.0,
    reserveCutoff120: 94.0,
    note: 'High Western Sydney demand compressed into 120 spots (~48 general per gender).',
  },
  {
    id: 'st_george_girls',
    name: 'St George Girls High School',
    shortName: 'St George Girls',
    region: 'Kogarah',
    gender: 'girls',
    totalSpots: 150,
    boysSpots: 0,
    girlsSpots: 150,
    generalShare: 0.8,
    hscRankRecent: 12,
    firstRoundCutoff120: 96.0,
    reserveCutoff120: 93.0,
    note: 'Primary South Sydney girls selective (~120 general girls spots).',
  },
  {
    id: 'nbsc_manly',
    name: 'NBSC Manly Campus',
    shortName: 'Manly Selective',
    region: 'North Curl Curl',
    gender: 'coed',
    totalSpots: 150,
    boysSpots: 75,
    girlsSpots: 75,
    generalShare: 0.8,
    hscRankRecent: 15,
    firstRoundCutoff120: 95.5,
    reserveCutoff120: 92.5,
    note: 'Northern Beaches flagship co-ed selective (~60 general spots per gender).',
  },
  {
    id: 'sydney_tech',
    name: 'Sydney Technical High School',
    shortName: 'Sydney Tech',
    region: 'Bexley',
    gender: 'boys',
    totalSpots: 150,
    boysSpots: 150,
    girlsSpots: 0,
    generalShare: 0.8,
    hscRankRecent: 14,
    firstRoundCutoff120: 94.5,
    reserveCutoff120: 91.5,
    note: 'Primary South Sydney boys selective (~120 general boys spots).',
  },
  {
    id: 'hurlstone_day',
    name: 'Hurlstone Agricultural High School (Day)',
    shortName: 'Hurlstone (Day)',
    region: 'Glenfield',
    gender: 'coed',
    totalSpots: 150,
    boysSpots: 75,
    girlsSpots: 75,
    generalShare: 0.8,
    hscRankRecent: 18,
    firstRoundCutoff120: 93.5,
    reserveCutoff120: 90.5,
    note: 'South-West Sydney day intake (~60 general spots per gender; boarding tracked separately).',
  },
  {
    id: 'caringbah',
    name: 'Caringbah High School',
    shortName: 'Caringbah',
    region: 'Caringbah',
    gender: 'coed',
    totalSpots: 150,
    boysSpots: 75,
    girlsSpots: 75,
    generalShare: 0.8,
    hscRankRecent: 17,
    firstRoundCutoff120: 92.0,
    reserveCutoff120: 89.0,
    note: 'Sutherland Shire co-ed selective (~60 general spots per gender).',
  },
  {
    id: 'penrith',
    name: 'Penrith High School',
    shortName: 'Penrith',
    region: 'Penrith',
    gender: 'coed',
    totalSpots: 150,
    boysSpots: 75,
    girlsSpots: 75,
    generalShare: 0.8,
    hscRankRecent: 19,
    firstRoundCutoff120: 90.5,
    reserveCutoff120: 87.5,
    note: 'Outer-West co-ed selective (~60 general spots per gender).',
  },
  {
    id: 'gosford',
    name: 'Gosford High School',
    shortName: 'Gosford',
    region: 'Gosford',
    gender: 'coed',
    totalSpots: 180,
    boysSpots: 90,
    girlsSpots: 90,
    generalShare: 0.8,
    hscRankRecent: 22,
    firstRoundCutoff120: 88.5,
    reserveCutoff120: 85.5,
    note: 'Expanded 180-spot Central Coast intake (~72 general spots per gender).',
  },
  {
    id: 'smiths_hill',
    name: 'Smiths Hill High School',
    shortName: 'Smiths Hill',
    region: 'Wollongong',
    gender: 'coed',
    totalSpots: 120,
    boysSpots: 60,
    girlsSpots: 60,
    generalShare: 0.8,
    hscRankRecent: 25,
    firstRoundCutoff120: 87.5,
    reserveCutoff120: 84.5,
    note: 'Illawarra regional selective (~48 general spots per gender).',
  },
];

// Abramowitz & Stegun 7.1.26 erf approximation (max error < 1.5e-7)
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t) *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function percentileToNswBand(percentile: number): NswPerformanceBand {
  if (percentile >= 90) return 'top_10';
  if (percentile >= 75) return 'next_15';
  if (percentile >= 50) return 'next_25';
  return 'lowest_50';
}

// SD of weighted sum of 4 correlated unit normals (empirical inter-section r ≈ 0.595)
function compositeWeightSd(weights: Record<SectionCode, number>): number {
  const r = 0.595;
  const w = [weights.READ, weights.MATH, weights.THINK, weights.WRIT];
  let variance = 0;
  for (let i = 0; i < w.length; i++) {
    for (let j = 0; j < w.length; j++) {
      variance += w[i] * w[j] * (i === j ? 1 : r);
    }
  }
  return Math.sqrt(Math.max(0.01, variance));
}

function zToScaled120(z: number): number {
  // Anchored: z=0 (50th pct) -> 66, z=1.28 (90th) -> 89.8, z=2.05 (98th) -> 104.1, z=2.33 (99th) -> 109.3
  return round1(clamp(66 + z * 18.6, 0, 120));
}

function scaled120ToZ(scaled120: number): number {
  return (scaled120 - 66) / 18.6;
}

function isSchoolEligibleForGender(school: NswSelectiveSchoolSpec, filter: ApplicantGenderFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'girls') return school.girlsSpots > 0;
  return school.boysSpots > 0;
}

function getEligibleSpotsForGender(school: NswSelectiveSchoolSpec, filter: ApplicantGenderFilter): number {
  if (filter === 'girls') return school.girlsSpots;
  if (filter === 'boys') return school.boysSpots;
  return school.totalSpots;
}

function classifyOfferStatus(score120: number, firstRound120: number, reserve120: number): SchoolOfferStatus {
  if (score120 >= firstRound120 + 1.5) return 'likely_offer';
  if (score120 >= firstRound120 - 1.5) return 'borderline_offer';
  if (score120 >= reserve120 - 1.0) return 'reserve_range';
  if (score120 >= reserve120 - 5.0) return 'reach';
  return 'below';
}

function computeUniformRawPctForCutoff(
  cutoff120: number,
  difficulty: BenchmarkDifficultyPreset,
  weighting: BenchmarkWeightingMode
): number {
  const cal = DIFFICULTY_CALIBRATION[difficulty];
  const weights = BENCHMARK_WEIGHTINGS[weighting];
  const compSd = compositeWeightSd(weights);
  const targetZComp = scaled120ToZ(cutoff120);
  const targetWeightedZ = targetZComp * compSd;

  // Solve sum(w_s * (p - mu_s) / sd_s) = targetWeightedZ for uniform raw percentage p
  let num = targetWeightedZ;
  let den = 0;
  for (const sec of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
    const w = weights[sec];
    num += (w * cal.cohortMeanPct[sec]) / cal.cohortSdPct[sec];
    den += w / cal.cohortSdPct[sec];
  }
  return Math.round(clamp(num / Math.max(0.0001, den), 0, 100));
}

export function evaluateNswBenchmark(input: BenchmarkScoreInput): NswBenchmarkReport {
  const weighting: BenchmarkWeightingMode = input.weighting ?? 'official_2025_equal';
  const genderFilter: ApplicantGenderFilter = input.genderFilter ?? 'all';
  const cal = DIFFICULTY_CALIBRATION[input.difficulty];
  const weights = BENCHMARK_WEIGHTINGS[weighting];
  const compSd = compositeWeightSd(weights);

  const bySecInput: Record<SectionCode, BenchmarkSectionInput> = {
    READ: input.read,
    MATH: input.math,
    THINK: input.think,
    WRIT: input.writ,
  };

  const sections = {} as Record<SectionCode, BenchmarkSectionEvaluation>;
  let weightedZSum = 0;

  for (const sec of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
    const maxScore = Math.max(1, bySecInput[sec].maxScore);
    const score = clamp(bySecInput[sec].score, 0, maxScore);
    const rawPct = round1((score / maxScore) * 100);
    const zScore = clamp(
      (rawPct - cal.cohortMeanPct[sec]) / cal.cohortSdPct[sec],
      -3.0,
      3.1
    );
    const estPct = round1(clamp(normalCdf(zScore) * 100, 0.1, 99.9));
    weightedZSum += weights[sec] * zScore;
    sections[sec] = {
      section: sec,
      score,
      maxScore,
      rawPct,
      weight: weights[sec],
      zScore: Number(zScore.toFixed(3)),
      estimatedPercentile: estPct,
      band: percentileToNswBand(estPct),
    };
  }

  const compositeZ = Number(clamp(weightedZSum / compSd, -3.0, 3.1).toFixed(3));
  const estimatedPercentile = round1(clamp(normalCdf(compositeZ) * 100, 0.1, 99.9));
  const estimatedStateRank = Math.max(
    1,
    Math.min(
      ESTIMATED_NSW_APPLICANTS,
      Math.round(((100 - estimatedPercentile) / 100) * ESTIMATED_NSW_APPLICANTS)
    )
  );
  const scaledScore120 = zToScaled120(compositeZ);
  const scaledScore100 = round1((scaledScore120 / 120) * 100);

  const eligibleSchools = NSW_FULLY_SELECTIVE_SCHOOLS.filter((s) =>
    isSchoolEligibleForGender(s, genderFilter)
  );

  const countsByStatus: Record<SchoolOfferStatus, number> = {
    likely_offer: 0,
    borderline_offer: 0,
    reserve_range: 0,
    reach: 0,
    below: 0,
  };

  const schools: SchoolCutoffEstimate[] = eligibleSchools.map((school) => {
    const eligibleSpots = getEligibleSpotsForGender(school, genderFilter);
    const estimatedGeneralSpots = Math.round(eligibleSpots * school.generalShare);
    const status = classifyOfferStatus(
      scaledScore120,
      school.firstRoundCutoff120,
      school.reserveCutoff120
    );
    countsByStatus[status]++;
    return {
      school,
      eligibleSpots,
      estimatedGeneralSpots,
      firstRoundCutoff120: school.firstRoundCutoff120,
      reserveCutoff120: school.reserveCutoff120,
      equivalentRawPctNeeded: computeUniformRawPctForCutoff(
        school.firstRoundCutoff120,
        input.difficulty,
        weighting
      ),
      deltaFromFirstRound: round1(scaledScore120 - school.firstRoundCutoff120),
      deltaFromReserve: round1(scaledScore120 - school.reserveCutoff120),
      status,
    };
  });

  // Compute highest-leverage realistic single-section step (+3 slots for obj, +2 marks for writing)
  let highestLeverage: BenchmarkLeverageTip | null = null;
  const stepSpecs: { sec: SectionCode; delta: number; label: string }[] = [
    { sec: 'READ', delta: 3, label: '+3 Reading slots' },
    { sec: 'MATH', delta: 3, label: '+3 Maths Qs' },
    { sec: 'THINK', delta: 3, label: '+3 Thinking Qs' },
    { sec: 'WRIT', delta: 2, label: '+2/20 Writing' },
  ];

  for (const step of stepSpecs) {
    const cur = bySecInput[step.sec];
    if (cur.score >= cur.maxScore) continue;
    const actualDelta = Math.min(step.delta, cur.maxScore - cur.score);
    const nextScore = cur.score + actualDelta;
    const nextPct = (nextScore / Math.max(1, cur.maxScore)) * 100;
    const nextZ = clamp((nextPct - cal.cohortMeanPct[step.sec]) / cal.cohortSdPct[step.sec], -3.0, 3.1);
    const deltaZComp = ((nextZ - sections[step.sec].zScore) * weights[step.sec]) / compSd;
    const nextScaled = zToScaled120(clamp(compositeZ + deltaZComp, -3.0, 3.1));
    const gain = round1(nextScaled - scaledScore120);
    if (gain <= 0) continue;

    const unlockedSchools = schools
      .filter((s) => s.deltaFromFirstRound < 0 && nextScaled >= s.firstRoundCutoff120 - 1.5)
      .slice(0, 3)
      .map((s) => s.school.shortName);

    if (
      !highestLeverage ||
      gain > highestLeverage.scaledGain120 ||
      (gain === highestLeverage.scaledGain120 &&
        unlockedSchools.length > highestLeverage.unlockedSchools.length)
    ) {
      highestLeverage = {
        section: step.sec,
        delta: actualDelta,
        incrementLabel: step.label.replace(/^\+\d+/, `+${actualDelta}`),
        scaledGain120: gain,
        unlockedSchools,
      };
    }
  }

  return {
    scaledScore120,
    scaledScore100,
    uncertaintyHalfWidth120: BENCHMARK_UNCERTAINTY_HALF_WIDTH_120,
    compositeZ,
    estimatedPercentile,
    estimatedStateRank,
    estimatedApplicantPool: ESTIMATED_NSW_APPLICANTS,
    difficulty: input.difficulty,
    weighting,
    genderFilter,
    sections,
    schools,
    countsByStatus,
    highestLeverage,
  };
}

/**
 * Extracts per-section raw scores from a completed mock/benchmark session for instant estimator seeding.
 */
export function extractBenchmarkScoresFromSession(input: {
  questions: Pick<StudentQuestionView, 'questionId' | 'section' | 'formatType'>[];
  reviewResults: Record<string, MarkingResult[]>;
  writingReview?: { evaluations: WritingEvaluationRecord[] }[];
  sessionTitle?: string;
}): {
  hasObjectiveMultiSection: boolean;
  read: BenchmarkSectionInput;
  math: BenchmarkSectionInput;
  think: BenchmarkSectionInput;
  writ: BenchmarkSectionInput;
  sectionSources: Record<SectionCode, 'actual' | 'assumed'>;
  writingEvaluated: boolean;
  suggestedDifficulty: BenchmarkDifficultyPreset;
} {
  const counts: Record<'READ' | 'MATH' | 'THINK', { correct: number; total: number }> = {
    READ: { correct: 0, total: 0 },
    MATH: { correct: 0, total: 0 },
    THINK: { correct: 0, total: 0 },
  };

  for (const q of input.questions) {
    if (q.section === 'WRIT' || q.formatType === 'WRIT_TYPED_TASK') continue;
    const res = input.reviewResults[q.questionId] || [];
    for (const r of res) {
      counts[q.section].total++;
      if (r.isCorrect) counts[q.section].correct++;
    }
  }

  const activeObjSections = (['READ', 'MATH', 'THINK'] as const).filter(
    (s) => counts[s].total > 0
  );
  const hasObjectiveMultiSection = activeObjSections.length >= 2;

  const latestWritingEval = input.writingReview?.[0]?.evaluations?.[0];
  const writScore = latestWritingEval
    ? latestWritingEval.totalMarks ??
      latestWritingEval.criteriaScores.reduce((sum, c) => sum + Math.round(c.score), 0)
    : 14;
  const writMax = latestWritingEval?.maxTotalMarks ?? OFFICIAL_SECTION_MAX_MARKS.WRIT;

  const scaleToOfficial = (sec: 'READ' | 'MATH' | 'THINK'): BenchmarkSectionInput => {
    const c = counts[sec];
    const officialMax = OFFICIAL_SECTION_MAX_MARKS[sec];
    if (c.total <= 0) return { score: Math.round(officialMax * 0.72), maxScore: officialMax };
    return { score: c.correct, maxScore: c.total };
  };

  const titleLower = (input.sessionTitle || '').toLowerCase();
  let suggestedDifficulty: BenchmarkDifficultyPreset = 'selective_lab_timed';
  if (titleLower.includes('pt1') || titleLower.includes('pt2') || titleLower.includes('pt3') || titleLower.includes('official')) {
    suggestedDifficulty = 'official_sample';
  } else if (titleLower.includes('2026-11-23') || titleLower.includes('b11') || titleLower.includes('b12')) {
    suggestedDifficulty = 'selective_lab_hard';
  }

  return {
    hasObjectiveMultiSection,
    read: scaleToOfficial('READ'),
    math: scaleToOfficial('MATH'),
    think: scaleToOfficial('THINK'),
    writ: { score: clamp(writScore, 0, writMax), maxScore: writMax },
    sectionSources: {
      READ: counts.READ.total > 0 ? ('actual' as const) : ('assumed' as const),
      MATH: counts.MATH.total > 0 ? ('actual' as const) : ('assumed' as const),
      THINK: counts.THINK.total > 0 ? ('actual' as const) : ('assumed' as const),
      WRIT: latestWritingEval ? ('actual' as const) : ('assumed' as const),
    },
    writingEvaluated: Boolean(latestWritingEval),
    suggestedDifficulty,
  };
}

export interface ParentVerdictSummary {
  tier: 'ruse_tier' | 'top_selective' | 'selective_offer' | 'reserve_range' | 'building';
  headlineEn: string;
  headlineZh: string;
  sublineEn: string;
  sublineZh: string;
}

export function buildParentVerdict(report: NswBenchmarkReport): ParentVerdictSummary {
  const atOrAbove = report.schools.filter((s) => s.deltaFromFirstRound >= 0);
  const borderlineBelow = report.schools.filter(
    (s) => s.deltaFromFirstRound < 0 && s.status === 'borderline_offer'
  );
  const reserveOnly = report.schools.filter((s) => s.status === 'reserve_range');
  const onLineOrReserveCount = borderlineBelow.length + reserveOnly.length;
  const ruse = report.schools.find((s) => s.school.id === 'james_ruse');
  const nextAbove = [...report.schools].reverse().find((s) => s.deltaFromFirstRound < 0);

  if (ruse && ruse.deltaFromFirstRound >= 0) {
    return {
      tier: 'ruse_tier',
      headlineEn: 'Above first-round cutoff for James Ruse and all top selective schools',
      headlineZh: '已达 James Ruse 及所有顶尖精英中学首轮录取线',
      sublineEn: `Estimated ${report.scaledScore120.toFixed(1)} / 120 (est. state rank #${report.estimatedStateRank.toLocaleString()}), above cutoff at all ${atOrAbove.length} eligible selective schools.`,
      sublineZh: `预估折算分 ${report.scaledScore120.toFixed(1)} / 120（全州约第 #${report.estimatedStateRank.toLocaleString()} 名），全部 ${atOrAbove.length} 所可报精英中学均已达首轮线。`,
    };
  }

  if (ruse && ruse.status === 'borderline_offer') {
    const gap = Math.max(0.1, round1(ruse.firstRoundCutoff120 - report.scaledScore120));
    return {
      tier: 'ruse_tier',
      headlineEn: `On the borderline for James Ruse, ${gap.toFixed(1)} pts from first-round cutoff`,
      headlineZh: `紧贴 James Ruse 录取线，距首轮线仅差 ${gap.toFixed(1)} 分`,
      sublineEn: `${atOrAbove.length} schools above first-round cutoff, ${onLineOrReserveCount} on the line or in reserve range (est. state rank #${report.estimatedStateRank.toLocaleString()}).`,
      sublineZh: `${atOrAbove.length} 所已达首轮录取线，${onLineOrReserveCount} 所处于压线或候补区间（全州约第 #${report.estimatedStateRank.toLocaleString()} 名）。`,
    };
  }

  if (atOrAbove.length > 0) {
    const topNames = atOrAbove.slice(0, 2).map((s) => s.school.shortName);
    const gapTarget = nextAbove ?? ruse;
    const gapPts = gapTarget
      ? Math.max(0.1, round1(gapTarget.firstRoundCutoff120 - report.scaledScore120))
      : 0;
    const isTop = atOrAbove.some((s) =>
      ['north_sydney_boys', 'baulkham_hills', 'north_sydney_girls', 'hornsby_girls'].includes(s.school.id)
    );
    return {
      tier: isTop ? 'top_selective' : 'selective_offer',
      headlineEn:
        gapTarget && gapPts > 0
          ? `Above cutoff for ${topNames.join(' and ')}, ${gapPts.toFixed(1)} pts from ${gapTarget.school.shortName}`
          : `Above cutoff for ${topNames.join(' and ')}`,
      headlineZh:
        gapTarget && gapPts > 0
          ? `已达 ${topNames.join('、')} 录取线，距 ${gapTarget.school.shortName} 差 ${gapPts.toFixed(1)} 分`
          : `已达 ${topNames.join('、')} 录取线`,
      sublineEn: `${atOrAbove.length} schools above cutoff, ${onLineOrReserveCount} on the line or in reserve range (est. state rank #${report.estimatedStateRank.toLocaleString()}).`,
      sublineZh: `${atOrAbove.length} 所已达首轮录取线，${onLineOrReserveCount} 所处于压线或候补区间（全州约第 #${report.estimatedStateRank.toLocaleString()} 名）。`,
    };
  }

  if (borderlineBelow.length > 0) {
    const closest = borderlineBelow[borderlineBelow.length - 1];
    const gapPts = Math.max(0.1, round1(closest.firstRoundCutoff120 - report.scaledScore120));
    return {
      tier: 'reserve_range',
      headlineEn: `On the borderline for ${closest.school.shortName}, ${gapPts.toFixed(1)} pts to first-round cutoff`,
      headlineZh: `紧贴 ${closest.school.shortName} 录取线，距首轮线差 ${gapPts.toFixed(1)} 分`,
      sublineEn: `${onLineOrReserveCount} schools on the line or in reserve range (est. state rank #${report.estimatedStateRank.toLocaleString()}).`,
      sublineZh: `共 ${onLineOrReserveCount} 所学校处于压线或候补区间（全州约第 #${report.estimatedStateRank.toLocaleString()} 名）。`,
    };
  }

  if (reserveOnly.length > 0) {
    const topRes = reserveOnly.slice(0, 2).map((s) => s.school.shortName);
    const closest = reserveOnly[reserveOnly.length - 1];
    const gapPts = Math.max(0.1, round1(closest.firstRoundCutoff120 - report.scaledScore120));
    return {
      tier: 'reserve_range',
      headlineEn: `In reserve-list range for ${topRes.join(' and ')}, ${gapPts.toFixed(1)} pts to first-round offer`,
      headlineZh: `处于 ${topRes.join('、')} 候补区间，距首轮录取差 ${gapPts.toFixed(1)} 分`,
      sublineEn: `${reserveOnly.length} selective schools in reserve range — a focused lift in one section unlocks first-round offers.`,
      sublineZh: `共 ${reserveOnly.length} 所精英中学处于候补区间，补强单科即可跨入首轮录取。`,
    };
  }

  const lowestSchool = report.schools[report.schools.length - 1];
  const gapPts = lowestSchool
    ? Math.max(0.1, round1(lowestSchool.reserveCutoff120 - report.scaledScore120))
    : 5;
  return {
    tier: 'building',
    headlineEn: `Building toward selective entry, ${gapPts.toFixed(1)} pts to first reserve cutoff`,
    headlineZh: `正在夯实基础，距首所精英中学候补线差 ${gapPts.toFixed(1)} 分`,
    sublineEn: `Estimated ${report.scaledScore120.toFixed(1)} / 120 (P${report.estimatedPercentile.toFixed(0)}). Focus on accuracy and exam-pace completion first.`,
    sublineZh: `预估折算分 ${report.scaledScore120.toFixed(1)} / 120（第 ${report.estimatedPercentile.toFixed(0)} 百分位），优先提升基础正确率与限时完成度。`,
  };
}

/**
 * Builds an immutable official BenchmarkReportRecord directly from a completed benchmark session.
 * All numbers are strictly deterministic (never LLM-generated).
 */
export function buildBenchmarkReportRecord(input: {
  session: SessionRecord;
  questions: Pick<QuestionItem, 'questionId' | 'section' | 'formatType' | 'batchLabel' | 'parts'>[];
  reviewResults: Record<string, MarkingResult[]>;
  writingReview?: { submissionId: string; evaluations: WritingEvaluationRecord[] }[];
  existingAiCoaching?: BenchmarkReportRecord['aiCoaching'];
}): BenchmarkReportRecord {
  const { session, questions, reviewResults, writingReview, existingAiCoaching } = input;
  const secTallies: Record<'READ' | 'MATH' | 'THINK', { correct: number; total: number; unanswered: number }> = {
    READ: { correct: 0, total: 0, unanswered: 0 },
    MATH: { correct: 0, total: 0, unanswered: 0 },
    THINK: { correct: 0, total: 0, unanswered: 0 },
  };
  const skillTallies = new Map<
    string,
    { skillId: string; section: SectionCode; missed: number; total: number; unanswered: number }
  >();

  let detectedBatchLabel = '';
  let hasWritingTask = false;

  for (const q of questions) {
    if (!detectedBatchLabel && q.batchLabel) detectedBatchLabel = q.batchLabel;
    if (q.section === 'WRIT' || q.formatType === 'WRIT_TYPED_TASK') {
      hasWritingTask = true;
      continue;
    }
    const resList = reviewResults[q.questionId] || [];
    const resByPartId = new Map(resList.map((r) => [r.partId, r]));
    for (const part of q.parts) {
      const r = resByPartId.get(part.partId);
      const isCorrect = Boolean(r?.isCorrect);
      const isUnanswered = !r || r.selectedAnswer === null;
      secTallies[q.section].total++;
      if (isCorrect) secTallies[q.section].correct++;
      if (isUnanswered) secTallies[q.section].unanswered++;

      const sk = skillTallies.get(part.skillId) || {
        skillId: part.skillId,
        section: q.section,
        missed: 0,
        total: 0,
        unanswered: 0,
      };
      sk.total++;
      if (!isCorrect) sk.missed++;
      if (isUnanswered) sk.unanswered++;
      skillTallies.set(part.skillId, sk);
    }
  }

  const writingEntry = writingReview?.[0];
  const latestWritingEval = writingEntry?.evaluations?.[0];
  const writingStatus: BenchmarkReportRecord['writingStatus'] = !hasWritingTask
    ? 'missing'
    : latestWritingEval
      ? 'graded'
      : 'pending';
  const writMax = latestWritingEval?.maxTotalMarks ?? OFFICIAL_SECTION_MAX_MARKS.WRIT;
  const writScore = latestWritingEval
    ? latestWritingEval.totalMarks ??
      latestWritingEval.criteriaScores.reduce((sum, c) => sum + Math.round(c.score), 0)
    : 14; // Neutral Band B/C placeholder while awaiting Writing grading

  const labelLower = `${detectedBatchLabel} ${session.title || ''}`.toLowerCase();
  let difficulty: BenchmarkDifficultyPreset = 'selective_lab_timed';
  if (labelLower.includes('pt1') || labelLower.includes('pt2') || labelLower.includes('pt3') || labelLower.includes('official')) {
    difficulty = 'official_sample';
  } else if (labelLower.includes('2026-11-23') || labelLower.includes('b11') || labelLower.includes('b12')) {
    difficulty = 'selective_lab_hard';
  }

  const evaluated = evaluateNswBenchmark({
    read: {
      score: secTallies.READ.total > 0 ? secTallies.READ.correct : Math.round(OFFICIAL_SECTION_MAX_MARKS.READ * 0.72),
      maxScore: secTallies.READ.total > 0 ? secTallies.READ.total : OFFICIAL_SECTION_MAX_MARKS.READ,
    },
    math: {
      score: secTallies.MATH.total > 0 ? secTallies.MATH.correct : Math.round(OFFICIAL_SECTION_MAX_MARKS.MATH * 0.72),
      maxScore: secTallies.MATH.total > 0 ? secTallies.MATH.total : OFFICIAL_SECTION_MAX_MARKS.MATH,
    },
    think: {
      score: secTallies.THINK.total > 0 ? secTallies.THINK.correct : Math.round(OFFICIAL_SECTION_MAX_MARKS.THINK * 0.72),
      maxScore: secTallies.THINK.total > 0 ? secTallies.THINK.total : OFFICIAL_SECTION_MAX_MARKS.THINK,
    },
    writ: { score: clamp(writScore, 0, writMax), maxScore: writMax },
    difficulty,
    weighting: 'official_2025_equal',
    genderFilter: 'all',
  });

  const sections: Record<SectionCode, BenchmarkReportSectionSnapshot> = {
    READ: {
      section: 'READ',
      correct: secTallies.READ.correct,
      total: secTallies.READ.total,
      unanswered: secTallies.READ.unanswered,
      accuracyPct: evaluated.sections.READ.rawPct,
      band: evaluated.sections.READ.band,
      estimatedPercentile: evaluated.sections.READ.estimatedPercentile,
      isAssumed: secTallies.READ.total === 0,
    },
    MATH: {
      section: 'MATH',
      correct: secTallies.MATH.correct,
      total: secTallies.MATH.total,
      unanswered: secTallies.MATH.unanswered,
      accuracyPct: evaluated.sections.MATH.rawPct,
      band: evaluated.sections.MATH.band,
      estimatedPercentile: evaluated.sections.MATH.estimatedPercentile,
      isAssumed: secTallies.MATH.total === 0,
    },
    THINK: {
      section: 'THINK',
      correct: secTallies.THINK.correct,
      total: secTallies.THINK.total,
      unanswered: secTallies.THINK.unanswered,
      accuracyPct: evaluated.sections.THINK.rawPct,
      band: evaluated.sections.THINK.band,
      estimatedPercentile: evaluated.sections.THINK.estimatedPercentile,
      isAssumed: secTallies.THINK.total === 0,
    },
    WRIT: {
      section: 'WRIT',
      correct: clamp(writScore, 0, writMax),
      total: writMax,
      unanswered: hasWritingTask ? 0 : 1,
      accuracyPct: evaluated.sections.WRIT.rawPct,
      band: evaluated.sections.WRIT.band,
      estimatedPercentile: evaluated.sections.WRIT.estimatedPercentile,
      isAssumed: writingStatus !== 'graded',
    },
  };

  const weakSkillStats = Array.from(skillTallies.values())
    .filter((s) => s.missed > 0)
    .sort((a, b) => b.missed - a.missed || b.unanswered - a.unanswered)
    .slice(0, 10);

  return {
    reportId: `brep_${session.sessionId}`,
    sessionId: session.sessionId,
    studentId: session.studentId || 'default-student',
    batchLabel: detectedBatchLabel || session.title || 'Benchmark Exam',
    title: session.title || `Benchmark: ${detectedBatchLabel || 'Official Holdout'}`,
    completedAtIso: session.completedAt || new Date().toISOString(),
    elapsedSec: session.checkpoint?.elapsedSec ?? 0,
    timeLimitSec: session.timeLimitSec ?? 9300,
    difficulty,
    scaledScore120: evaluated.scaledScore120,
    uncertaintyHalfWidth120: evaluated.uncertaintyHalfWidth120,
    estimatedPercentile: evaluated.estimatedPercentile,
    estimatedStateRank: evaluated.estimatedStateRank,
    estimatedApplicantPool: evaluated.estimatedApplicantPool,
    writingStatus,
    writingSubmissionId: writingEntry?.submissionId,
    sections,
    weakSkillStats,
    aiCoaching: existingAiCoaching,
  };
}
