import type { SectionCode } from './contracts.ts';

export interface SkillDefinition {
  skillId: string;
  section: SectionCode;
  familyCode: string;
  displayName: string;
  examWeightHint: number;
}

const RAW_SKILLS: [string, SectionCode, string, string, number][] = [
  ['READ.FIC.LITERAL_DETAIL','READ','READ.FIC','Fiction: Literal Detail',0.05],
  ['READ.FIC.CHARACTER_INFERENCE','READ','READ.FIC','Fiction: Character Inference',0.06],
  ['READ.FIC.IMPLIED_MEANING','READ','READ.FIC','Fiction: Implied Meaning',0.06],
  ['READ.FIC.TONE_ATTITUDE','READ','READ.FIC','Fiction: Tone & Attitude',0.05],
  ['READ.FIC.TECHNIQUE_EFFECT','READ','READ.FIC','Fiction: Technique & Effect',0.05],
  ['READ.FIC.TEXT_STRUCTURE','READ','READ.FIC','Fiction: Text Structure',0.04],
  ['READ.CLOZE.COLLOCATION','READ','READ.CLOZE','Cloze: Collocation',0.06],
  ['READ.CLOZE.CONTEXT_NUANCE','READ','READ.CLOZE','Cloze: Context Nuance',0.07],
  ['READ.CLOZE.DISCOURSE_CONNECTOR','READ','READ.CLOZE','Cloze: Discourse Connector',0.05],
  ['READ.POEM.LITERAL_SENSE','READ','READ.POEM','Poetry: Literal Sense',0.05],
  ['READ.POEM.FIGURATIVE_IMAGERY','READ','READ.POEM','Poetry: Figurative Imagery',0.06],
  ['READ.POEM.FORM_TONE_EFFECT','READ','READ.POEM','Poetry: Form, Tone & Effect',0.05],
  ['READ.GAP.COHESIVE_BRIDGE','READ','READ.GAP','Gapped Text: Cohesive Bridge',0.06],
  ['READ.GAP.REFERENTIAL_PRONOUN_LINK','READ','READ.GAP','Gapped Text: Referential Link',0.06],
  ['READ.GAP.PARAGRAPH_PROGRESSION','READ','READ.GAP','Gapped Text: Progression',0.05],
  ['READ.MATCH.PRECISE_CONDITION','READ','READ.MATCH','Matching: Precise Condition',0.06],
  ['READ.MATCH.CROSS_TEXT_COMPARE','READ','READ.MATCH','Matching: Cross-Text Compare',0.06],
  ['READ.MATCH.VIEWPOINT_CHANGE','READ','READ.MATCH','Matching: Viewpoint & Shift',0.06],
  ['MATH.NUM.DIVISIBILITY_REMAINDERS','MATH','MATH.NUM','Divisibility & Remainders',0.04],
  ['MATH.NUM.NUMBER_SEQUENCES','MATH','MATH.NUM','Number Sequences',0.03],
  ['MATH.NUM.PLACE_VALUE_DECIMALS','MATH','MATH.NUM','Place Value & Decimals',0.03],
  ['MATH.NUM.FACTORS_MULTIPLES_PRIMES','MATH','MATH.NUM','Factors, Multiples & Primes',0.04],
  ['MATH.FRAC.FRACTION_CHAINS','MATH','MATH.FRAC','Fraction of Remainder Chains',0.05],
  ['MATH.FRAC.TRUE_FALSE_STATEMENTS','MATH','MATH.FRAC','Fraction/Number Logic Statements',0.03],
  ['MATH.FRAC.RATIO_PROPORTION','MATH','MATH.FRAC','Ratio & Proportion',0.04],
  ['MATH.FRAC.PERCENTAGES','MATH','MATH.FRAC','Percentages',0.03],
  ['MATH.FRAC.PROBABILITY_DEPENDENT','MATH','MATH.FRAC','Probability & Combined Events',0.03],
  ['MATH.ALG.TWO_UNKNOWN_SYSTEMS','MATH','MATH.ALG','Two-Unknown Word Systems',0.04],
  ['MATH.ALG.WORKING_BACKWARDS','MATH','MATH.ALG','Working Backwards',0.04],
  ['MATH.ALG.SYMBOL_EQUATIONS','MATH','MATH.ALG','Symbol & Visual Equations',0.03],
  ['MATH.ALG.INEQUALITIES_BOUNDS','MATH','MATH.ALG','Inequalities & Bounds',0.03],
  ['MATH.ALG.DIGIT_CRYPT_PUZZLES','MATH','MATH.ALG','Digit & Column Puzzles',0.03],
  ['MATH.TIME.ELAPSED_24H','MATH','MATH.TIME','Elapsed & 24-Hour Time',0.03],
  ['MATH.TIME.TIME_ZONES_ITINERARY','MATH','MATH.TIME','Time Zones & Timetables',0.03],
  ['MATH.TIME.CLOCK_ANGLES','MATH','MATH.TIME','Clock Faces & Angles',0.02],
  ['MATH.MEAS.DIAL_GAUGE_OFFSET','MATH','MATH.MEAS','Dials, Scales & Offsets',0.03],
  ['MATH.MEAS.BALANCE_SCALES','MATH','MATH.MEAS','Balance Scales & Masses',0.03],
  ['MATH.MEAS.UNIT_CONVERSIONS','MATH','MATH.MEAS','Unit Conversions',0.03],
  ['MATH.GEO2D.COMPOSITE_AREA','MATH','MATH.GEO2D','Composite Area',0.05],
  ['MATH.GEO2D.COMPOSITE_PERIMETER','MATH','MATH.GEO2D','Composite Perimeter',0.04],
  ['MATH.GEO2D.ANGLES_PROTRACTOR','MATH','MATH.GEO2D','Angles & Polygons',0.04],
  ['MATH.GEO2D.SYMMETRY_ROTATION_REFLECT','MATH','MATH.GEO2D','Symmetry, Rotation & Reflection',0.03],
  ['MATH.GEO2D.COMPASS_TURNS','MATH','MATH.GEO2D','Compass & Degree Turns',0.03],
  ['MATH.GEO3D.CUBE_STACK_COUNT','MATH','MATH.GEO3D','3D Cube Stacks & Volumes',0.03],
  ['MATH.GEO3D.NETS_SOLIDS','MATH','MATH.GEO3D','Nets of 3D Solids',0.03],
  ['MATH.GEO3D.FACES_EDGES_VERTICES','MATH','MATH.GEO3D','Faces, Edges & Vertices',0.02],
  ['MATH.DATA.BAR_LINE_GRAPHS','MATH','MATH.DATA','Graphs & Charts',0.03],
  ['MATH.DATA.MEAN_RECONSTRUCTION','MATH','MATH.DATA','Averages & Mean Reconstruction',0.03],
  ['MATH.COMB.CONSTRAINED_OPTIMISATION','MATH','MATH.COMB','Constrained Integer Optimisation',0.04],
  ['MATH.COMB.GRID_PATHS_COORDS','MATH','MATH.COMB','Grids, Coordinates & Paths',0.03],
  ['THINK.VERBAL.STRENGTHEN_ARGUMENT','THINK','THINK.VERBAL','Strengthen Argument',0.06],
  ['THINK.VERBAL.WEAKEN_ARGUMENT','THINK','THINK.VERBAL','Weaken Argument',0.06],
  ['THINK.VERBAL.IDENTIFY_FLAW','THINK','THINK.VERBAL','Identify Reasoning Flaw',0.06],
  ['THINK.VERBAL.IMPLICIT_ASSUMPTION','THINK','THINK.VERBAL','Implicit Assumption',0.05],
  ['THINK.DEDUCT.WHOSE_REASONING_CORRECT','THINK','THINK.DEDUCT','Whose Reasoning is Correct?',0.08],
  ['THINK.DEDUCT.CONDITIONAL_CONTRAPOSITIVE','THINK','THINK.DEDUCT','Conditionals & Contrapositives',0.07],
  ['THINK.DEDUCT.LOGIC_GRID_CONSTRAINTS','THINK','THINK.DEDUCT','Logic Grid Constraints',0.06],
  ['THINK.DEDUCT.LINE_CIRCLE_ARRANGEMENT','THINK','THINK.DEDUCT','Seating & Spatial Arrangement',0.06],
  ['THINK.DEDUCT.DEDUCTIVE_ORDERING','THINK','THINK.DEDUCT','Deductive Ordering & Ranking',0.05],
  ['THINK.DEDUCT.SET_SYLLOGISMS','THINK','THINK.DEDUCT','Set & Quantifier Syllogisms',0.05],
  ['THINK.DEDUCT.KNIGHTS_AND_LIARS','THINK','THINK.DEDUCT','Truth-Tellers & Liars',0.04],
  ['THINK.DEDUCT.CRYPTOGRAM_MAPPING','THINK','THINK.DEDUCT','Code & Cryptogram Mapping',0.04],
  ['THINK.DEDUCT.CYCLE_CHAIN_REASONING','THINK','THINK.DEDUCT','Cycles & Repeating Chains',0.04],
  ['THINK.NUM.SYSTEMS_WORD_PUZZLES','THINK','THINK.NUM','Numerical Word Systems',0.05],
  ['THINK.NUM.MIN_COST_COMBINATIONS','THINK','THINK.NUM','Minimum-Cost Combinations',0.05],
  ['THINK.NUM.TABLE_CHART_RATE_LOGIC','THINK','THINK.NUM','Table & Rate Logic',0.04],
  ['THINK.NUM.OVERLAP_COUNTING','THINK','THINK.NUM','Overlaps & Inclusion-Exclusion',0.03],
  ['THINK.NUM.NETWORK_GRAPH_ROUTES','THINK','THINK.NUM','Networks & Route Logic',0.03],
  ['THINK.SPATIAL.VIEWS_3D_SILHOUETTES','THINK','THINK.SPATIAL','3D Views & Silhouettes',0.05],
  ['THINK.SPATIAL.FOLD_CUT_TILE_ASSEMBLY','THINK','THINK.SPATIAL','Folding, Cutting & Tiling',0.04],
  ['THINK.SPATIAL.PATTERN_ROTATION_SYMMETRY','THINK','THINK.SPATIAL','Visual Pattern & Symmetry',0.04],
  ['WRIT.CRIT.TOPIC_PROMPT_ADHERENCE','WRIT','WRIT.CRIT','Topic & Instruction Adherence',0.20],
  ['WRIT.CRIT.IDEAS_CREATIVITY','WRIT','WRIT.CRIT','Creativity & Depth of Ideas',0.20],
  ['WRIT.CRIT.PURPOSE_AUDIENCE_VOICE','WRIT','WRIT.CRIT','Purpose, Audience & Voice',0.15],
  ['WRIT.CRIT.STRUCTURE_LAYOUT','WRIT','WRIT.CRIT','Structure & Genre Conventions',0.15],
  ['WRIT.CRIT.STYLE_VOCABULARY','WRIT','WRIT.CRIT','Style, Imagery & Vocabulary',0.15],
  ['WRIT.CRIT.GRAMMAR_SPELLING_PUNCT','WRIT','WRIT.CRIT','Grammar, Punctuation & Spelling',0.15]
];

export const SKILLS_TAXONOMY: SkillDefinition[] = RAW_SKILLS.map(
  ([skillId, section, familyCode, displayName, examWeightHint]) => ({
    skillId, section, familyCode, displayName, examWeightHint
  })
);

export const VALID_SKILL_IDS = new Set(SKILLS_TAXONOMY.map((s) => s.skillId));