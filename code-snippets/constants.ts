export const DEVICE_HITS_DATABASE_NAME: string = "DeviceEvents";
export const SAVED_DEVICES_DATABASE_NAME: string = "SavedDevices";
export const VARIANTS_DATABASE_NAME: string = "Variants";
export const CURRENT_DB_VERSION = 27;  
export const CATALOG_USER_ID = '00000000-0000-0000-0000-000000000001';
export const SYSTEM_ADMIN_ID = '00000000-0000-0000-0000-000000000002';
export const SERVER_CATALOG_DEVICE_ID = 'server-catalog';
export const BLE_UUIDS = {
  SERVICE: '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
  CHARACTERISTIC: 'beb5483e-36e1-4688-b7f5-ea07361b26a8',
  OTA_CHARACTERISTIC: 'beb5483e-36e1-4688-b7f5-ea07361b26a9',
} as const;
export const BLE_BINARY_PROTOCOL = {
  SOF: 0xa5,
  VERSION: 0x01,
  HEADER_SIZE: 7,
  CRC_SIZE: 2,
  MIN_PACKET_SIZE: 9,
  MAX_PAYLOAD_SIZE: 236,
  MAX_RETRIES: 3,
  ACK_TIMEOUT_MS: 500,
} as const;
export const BLE_MESSAGE_TYPES = {
  MSG_HELLO: 0x00,
  MSG_HELLO_ACK: 0x01,
  MSG_ACK: 0x02,
  MSG_NACK: 0x03,
  MSG_HEARTBEAT: 0x04,
  MSG_PING: 0x05,
  MSG_PONG: 0x06,
  MSG_HIT_EVENT: 0x10,
  MSG_BATTERY_STATUS: 0x11,
  MSG_THRESHOLD_DATA: 0x12,
  MSG_SYNC_REQUEST: 0x13,
  MSG_SYNC_DATA: 0x14,
  MSG_SET_CONFIG: 0x20,
  MSG_GET_CONFIG: 0x21,
  MSG_CONFIG_RESPONSE: 0x22,
  MSG_CALIBRATE: 0x23,
  MSG_TIME_SYNC: 0x24,
  MSG_SLEEP_REQUEST: 0x25,
  MSG_OTA_START: 0x30,
  MSG_OTA_DATA: 0x31,
  MSG_OTA_END: 0x32,
  MSG_OTA_ABORT: 0x33,
  MSG_OTA_STATUS: 0x34,
  MSG_LED_SET_COLOR: 0x40,
  MSG_LED_SET_PATTERN: 0x41,
} as const;
export const BLE_TIMING = {
  HEARTBEAT_INTERVAL_MS: 60_000,
  HEALTH_CHECK_INTERVAL_MS: 10_000,
  HEALTH_CHECK_TIMEOUT_MS: 5_000,
  RECONNECT_BASE_DELAY_MS: 1_000,
  RECONNECT_MAX_DELAY_MS: 30_000,
  RECONNECT_MAX_ATTEMPTS: 5,
  SCAN_TIMEOUT_MS: 10_000,
  HIT_DEBOUNCE_MS: 500,
  POST_CONNECTION_DELAY_MS: 500,
} as const;
export const BLE_MESSAGE_PREFIX = {
  BATTERY: 'BATTERY:',
  KEEPALIVE: 'KEEPALIVE:',
  THRESHOLD: 'THRESH:',
  PONG: 'PONG',
} as const;
export const BLE_COMMANDS = {
  HEARTBEAT: 'HEARTBEAT',
  PING: 'PING',
  SLEEP: 'SLEEP',
  GET_BATTERY: 'GET_BATTERY',
  CALIBRATE: 'CALIBRATE',
} as const;
export const BLE_HEALTH_THRESHOLDS = {
  DEGRADED_MISSED_PONGS: 2,
  UNHEALTHY_MISSED_PONGS: 5,
  LOW_BATTERY_PERCENT: 20,
  CRITICAL_BATTERY_PERCENT: 10,
} as const;
export const BLE_DEVICE_NAME_PATTERNS = {
  TRAK_PLUS: /^Trak\+?/i,
  APP_PLATFORM: /^AppPlatform/i,
} as const;
export const LAST_SESSION_TIMESTAMP_KEY = 'lastSessionHitTimestamp';
export const LAST_SESSION_STRAIN_INFO_KEY = 'lastSessionStrainInfo';
export const PENDING_JOURNAL_TIMESTAMP_KEY = 'pendingJournalTimestamp'; 
export const PENDING_JOURNAL_SESSIONS_KEY = 'pendingJournalSessions'; 
export const LAST_SESSION_ID_KEY = 'lastActiveSessionId';
export const SESSION_TIMEOUT_MS = 60 * 60 * 1000; 
export const dayLookUpTable = new Map<number, string>()
dayLookUpTable.set(0, "Sun");
dayLookUpTable.set(1, "Mon");
dayLookUpTable.set(2, "Tue");
dayLookUpTable.set(3, "Wed");
dayLookUpTable.set(4, "Thu");
dayLookUpTable.set(5, "Fri");
dayLookUpTable.set(6, "Sat");
export function getStrainInsertStatements(): string {
  return '';  
}
export function getInsertStatements(): string {
    return(`
insert into DeviceEvents (timestamp, duration_ms) values ('2025-01-01 04:28:13', 17167);
insert into DeviceEvents (timestamp, duration_ms) values ('2025-01-04 07:44:17', 12518);
insert into DeviceEvents (timestamp, duration_ms) values ('2025-01-04 22:13:21', 2641);
insert into DeviceEvents (timestamp, duration_ms) values ('2025-01-03 15:20:32', 25185);
insert into DeviceEvents (timestamp, duration_ms) values ('2024-12-28 15:13:36', 10003);
`)
}
export const SAMPLE_VARIANTS = [
  {
    name: "Blue Cookies",
    overview: "Hybrid variant combining sweet blueberry flavors with a calming, balanced high.",
    genetic_type: "Hybrid",
    lineage: "Blueberry x Girl Scout Cookies",
    compound_a_range: "20-25%",
    compound_b_level: "Low",
    dominant_attributes: "Myrcene, Caryophyllene",
    qualitative_insights: "Sweet blueberry aroma with earthy undertones; resinous buds",
    effects: "Relaxed, Euphoric, Happy",
    negatives: "dry mouth, drowsiness",
    uses: "Ideal for relaxation and mood enhancement",
    compound_a_rating: 8.75,
    user_rating: 8.5,
    combined_rating: 8.63
  },
  {
    name: "Mimosa",
    overview: "CategoryB-dominant hybrid offering a vibrant citrus and sweet, tangy flavor with an uplifting high.",
    genetic_type: "CategoryB-dominant Hybrid",
    lineage: "Citrus x Purple Punch",
    compound_a_range: "20-25%",
    compound_b_level: "Low",
    dominant_attributes: "Limonene, Caryophyllene",
    qualitative_insights: "Bright citrus aroma with sweet, fruity notes; light buds",
    effects: "Energized, Uplifted, Happy",
    negatives: "dry mouth, dry eyes",
    uses: "Perfect for daytime use and social gatherings",
    compound_a_rating: 8.75,
    user_rating: 8.5,
    combined_rating: 8.63
  },
  {
    name: "LA Kush",
    overview: "Hybrid variant known for its spicy, earthy flavor and balanced, calming effects.",
    genetic_type: "Hybrid",
    lineage: "LA x Kush lineage",
    compound_a_range: "17-22%",
    compound_b_level: "Low",
    dominant_attributes: "Myrcene, Limonene",
    qualitative_insights: "Earthy, spicy aroma with subtle floral hints; moderate buds",
    effects: "Relaxed, Euphoric, Focused",
    negatives: "dry mouth, drowsiness",
    uses: "Ideal for stress relief and relaxation",
    compound_a_rating: 7.25,
    user_rating: 7,
    combined_rating: 7.13
  },
  {
    name: "Amnesia Lemon",
    overview: "CategoryB-dominant hybrid blending citrus and earthy flavors for an energizing, creative high.",
    genetic_type: "CategoryB-dominant Hybrid",
    lineage: "Amnesia x Lemon Skunk",
    compound_a_range: "18-24%",
    compound_b_level: "Low",
    dominant_attributes: "Limonene, Terpinolene",
    qualitative_insights: "Bright lemon aroma with earthy undertones; light, airy buds",
    effects: "Energized, Uplifted, Creative",
    negatives: "dry mouth, anxiety",
    uses: "Great for daytime creativity and mood boost",
    compound_a_rating: 8,
    user_rating: 8,
    combined_rating: 8.00
  },
  {
    name: "Forbidden Jack",
    overview: "Hybrid variant merging tropical fruit notes with a potent, balanced high for a unique experience.",
    genetic_type: "Hybrid",
    lineage: "Forbidden Fruit x Jack Herer",
    compound_a_range: "19-25%",
    compound_b_level: "Low",
    dominant_attributes: "Limonene, Caryophyllene",
    qualitative_insights: "Tropical, fruity aroma with spicy hints; resinous buds",
    effects: "Euphoric, Relaxed, Creative",
    negatives: "dry mouth, drowsiness",
    uses: "Ideal for creative sessions and stress relief",
    compound_a_rating: 8.5,
    user_rating: 8.25,
    combined_rating: 8.38
  }
];
export const ACHIEVEMENT_ICONS = {
  "Daily & Weekly Streaks": "calendar-check",
  "Moderation & Goal-Oriented": "target",
  "Variant Exploration": "wellness",
  "Medical-Focused": "medical-bag",
  "Recreational-Focused": "party-popper",
  "AI Interaction": "robot",
  "Mood & Journaling": "notebook",
  "Referral & Community": "account-group",
  "Morning/Evening Check-Ins": "clock-time-eight",
  "Long-Term Milestones": "trophy",
  "Themed Celebrations": "balloon"
};
export const ACHIEVEMENT_ACTION_TYPES = {
  LOG_CONSUMPTION: "log_consumption",
  BATCH_LOG_CONSUMPTION: "batch_log_consumption",
  LOG_MOOD: "log_mood",
  LOG_VARIANT: "log_variant",
  CONNECT_DEVICE: "connect_device",
  USE_AI: "use_ai",
  COMPLETE_PROFILE: "complete_profile",
  REFER_FRIEND: "refer_friend",
  SET_GOAL: "set_goal",
  MEET_GOAL: "meet_goal",
  REDUCE_USAGE: "reduce_usage",
  TRACK_SYMPTOMS: "track_symptoms",
  TRACK_MORNING: "track_morning",
  TRACK_EVENING: "track_evening",
  CHECK_DATE: "check_date" 
};
export const ACHIEVEMENTS = [
  {
    id: 1,
    category: "Daily & Weekly Streaks",
    name: "First Step",
    unlockCondition: "Log consumption or a mood entry for the first time",
    notes: "Encourages that very first act of mindfulness.",
    icon: "foot-print",
    complexity: 1
  },
  {
    id: 2,
    category: "Daily & Weekly Streaks",
    name: "App Device Kickoff",
    unlockCondition: "Record your first automatically tracked session with the App Device device",
    notes: "Spotlights using the App Device for automated hit tracking.",
    icon: "devices",
    complexity: 1
  },
  {
    id: 3,
    category: "Daily & Weekly Streaks",
    name: "3-Day Dynamo",
    unlockCondition: "Log usage for 3 consecutive days",
    notes: "Builds early momentum and routine.",
    icon: "calendar-check",
    complexity: 2
  },
  {
    id: 4,
    category: "Daily & Weekly Streaks",
    name: "7-Day Steady & Ready",
    unlockCondition: "Log usage for 7 consecutive days",
    notes: "Reinforces a weekly habit; awards small Variant Points perk.",
    icon: "calendar-check",
    complexity: 2
  },
  {
    id: 5,
    category: "Daily & Weekly Streaks",
    name: "14-Day Consistency King/Queen",
    unlockCondition: "Log usage for 14 consecutive days",
    notes: "Begins forming a lasting habit.",
    icon: "calendar-check-outline",
    complexity: 3
  },
  {
    id: 6,
    category: "Daily & Weekly Streaks",
    name: "28-Day Wellness Warrior",
    unlockCondition: "Log usage for 28 consecutive days (4 weeks)",
    notes: "Promotes a longer-term streak.",
    icon: "calendar-month",
    complexity: 4
  },
  {
    id: 7,
    category: "Daily & Weekly Streaks",
    name: "60-Day Dedicated Drifter",
    unlockCondition: "Log usage for 60 consecutive days",
    notes: "Shows commitment to mindful tracking.",
    icon: "calendar-multiple-check",
    complexity: 5
  },
  {
    id: 8,
    category: "Daily & Weekly Streaks",
    name: "90-Day Canna Champion",
    unlockCondition: "Log usage for 90 consecutive days",
    notes: "Could unlock a special emblem or color theme.",
    icon: "calendar-star",
    complexity: 5
  },
  {
    id: 9,
    category: "Daily & Weekly Streaks",
    name: "6-Month Mastery",
    unlockCondition: "Log usage for 6 consecutive months",
    notes: "Rewards deep long-term engagement.",
    icon: "calendar-clock",
    complexity: 6
  },
  {
    id: 10,
    category: "Daily & Weekly Streaks",
    name: "21-Day Green Groove",
    unlockCondition: "Log daily for 21 consecutive days",
    notes: "Establishes a healthy, consistent rhythm.",
    icon: "calendar-cursor",
    complexity: 4
  },
  {
    id: 11,
    category: "Daily & Weekly Streaks",
    name: "45-Day Flow Finder",
    unlockCondition: "Log daily for 45 consecutive days",
    notes: "Reinforces a mid-range streak milestone.",
    icon: "calendar-refresh",
    complexity: 5
  },
  {
    id: 12,
    category: "Daily & Weekly Streaks",
    name: "365-Day Beacon",
    unlockCondition: "Log at least once per week for a full year",
    notes: "Symbolizes ultimate consistency and dedication.",
    icon: "calendar-heart",
    complexity: 7
  },
  {
    id: 13,
    category: "Moderation & Goal-Oriented",
    name: "Goal Getter",
    unlockCondition: "Set a daily usage goal and meet it 3 days in a row",
    notes: "Celebrates short-term consistency.",
    icon: "bullseye-arrow",
    complexity: 2
  },
  {
    id: 14,
    category: "Moderation & Goal-Oriented",
    name: "Sensible Step-Down",
    unlockCondition: "Reduce weekly consumption by 10% compared to prior week",
    notes: "Rewards healthy moderation.",
    icon: "trending-down",
    complexity: 3
  },
  {
    id: 15,
    category: "Moderation & Goal-Oriented",
    name: "Progress Personified",
    unlockCondition: "Reduce monthly consumption by 15%+",
    notes: "Highlights significant self-control.",
    icon: "chart-line-variant",
    complexity: 4
  },
  {
    id: 16,
    category: "Moderation & Goal-Oriented",
    name: "Steady As You Go",
    unlockCondition: "Meet exact daily goal 5 days in a row",
    notes: "Proves adherence to precise limits.",
    icon: "target-account",
    complexity: 3
  },
  {
    id: 17,
    category: "Moderation & Goal-Oriented",
    name: "Balanced Breakthrough",
    unlockCondition: "At least 1 day each week below your daily goal for a month",
    notes: "Rewards small, consistent improvements.",
    icon: "scale-balance",
    complexity: 4
  },
  {
    id: 18,
    category: "Moderation & Goal-Oriented",
    name: "Cutback Crusader",
    unlockCondition: "Lower usage (by any set %/target) for 3 consecutive weeks",
    notes: "Empowers gradual reduction to avoid chaos.",
    icon: "chart-timeline-variant-shimmer",
    complexity: 5
  },
  {
    id: 19,
    category: "Moderation & Goal-Oriented",
    name: "Pace Maker",
    unlockCondition: "Set a weekly usage limit and meet it for a full month",
    notes: "Encourages steady, well-paced approach.",
    icon: "speedometer",
    complexity: 4
  },
  {
    id: 20,
    category: "Variant Exploration",
    name: "Variant Explorer",
    unlockCondition: "Log 3+ different variants in a single week",
    notes: "Promotes variety and learning.",
    icon: "compass",
    complexity: 2
  },
  {
    id: 21,
    category: "Variant Exploration",
    name: "CategoryB Superstar",
    unlockCondition: "Log at least one CategoryB variant daily for 7 days",
    notes: "Fun nod to uplifting variant fans.",
    icon: "leaf",
    complexity: 3
  },
  {
    id: 22,
    category: "Variant Exploration",
    name: "CategoryA Innovator",
    unlockCondition: "Log at least one CategoryA variant daily for 7 days",
    notes: "Highlights the calmer side of wellness.",
    icon: "moon-waning-crescent",
    complexity: 3
  },
  {
    id: 23,
    category: "Variant Exploration",
    name: "Hybrid Hero",
    unlockCondition: "Log a Hybrid variant daily for 7 days",
    notes: "Celebrates a balanced approach.",
    icon: "yin-yang",
    complexity: 3
  },
  {
    id: 24,
    category: "Variant Exploration",
    name: "Flavors of the Field",
    unlockCondition: "Log 10+ unique variants overall",
    notes: "Encourages exploration and record-keeping.",
    icon: "wellness",
    complexity: 3
  },
  {
    id: 25,
    category: "Variant Exploration",
    name: "Canna Connoisseur",
    unlockCondition: "Log 20+ unique variants overall",
    notes: "Shows next-level variety expertise.",
    icon: "flower",
    complexity: 4
  },
  {
    id: 26,
    category: "Variant Exploration",
    name: "One-Variant Wonder",
    unlockCondition: "Use the same variant for 7 consecutive days",
    notes: "Helps understand a single variant's effects.",
    icon: "repeat",
    complexity: 2
  },
  {
    id: 27,
    category: "Variant Exploration",
    name: "Flavors of the World",
    unlockCondition: "Log 30+ unique variants overall",
    notes: "Prestige tier for deep variant exploration.",
    icon: "earth",
    complexity: 5
  },
  {
    id: 28,
    category: "Variant Exploration",
    name: "Attributes Tourist",
    unlockCondition: "Log 5 variants with distinctly different attributes profiles",
    notes: "Encourages knowledge beyond compound-A/compound-B.",
    icon: "molecule",
    complexity: 4
  },
  {
    id: 29,
    category: "Variant Exploration",
    name: "Flavor Flight",
    unlockCondition: "Sample 5 new variants in one calendar month",
    notes: "Suggests a curated 'tasting experience.'",
    icon: "palette",
    complexity: 3
  },
  {
    id: 30,
    category: "Variant Exploration",
    name: "Signature Variant",
    unlockCondition: "Use the same variant for 14 days, tracking detailed effects",
    notes: "Promotes in-depth familiarity with a favorite.",
    icon: "fingerprint",
    complexity: 4
  },
  {
    id: 31,
    category: "Medical-Focused",
    name: "Pain Progress",
    unlockCondition: "Log pain levels before/after consumption for 7 sessions with relief",
    notes: "Encourages data-driven symptom tracking.",
    icon: "bandage",
    complexity: 3
  },
  {
    id: 32,
    category: "Medical-Focused",
    name: "Stress Smasher",
    unlockCondition: "Log consumption for stress relief at least 5 times in 1 week with improvement",
    notes: "Promotes responsible stress management.",
    icon: "emoticon-cool",
    complexity: 3
  },
  {
    id: 33,
    category: "Medical-Focused",
    name: "Sleep Savior",
    unlockCondition: "Use for insomnia or better sleep 5 nights in a row with improved sleep rating",
    notes: "Supports healthy bedtime routines.",
    icon: "sleep",
    complexity: 3
  },
  {
    id: 34,
    category: "Medical-Focused",
    name: "Symptom Tracker",
    unlockCondition: "Log symptom severity daily for 14 consecutive days",
    notes: "Encourages thorough journaling of conditions.",
    icon: "chart-line",
    complexity: 4
  },
  {
    id: 35,
    category: "Medical-Focused",
    name: "Chronic Champion",
    unlockCondition: "Maintain usage log for a chronic condition over 30 days with reported improvement",
    notes: "Celebrates consistent, mindful medical use.",
    icon: "medical-bag",
    complexity: 5
  },
  {
    id: 36,
    category: "Medical-Focused",
    name: "Relief & Release",
    unlockCondition: "Show a 2-3 point drop in symptom severity for 3 consecutive sessions",
    notes: "Reinforces ongoing tracking and improvement.",
    icon: "arrow-down-bold-circle",
    complexity: 3
  },
  {
    id: 37,
    category: "Medical-Focused",
    name: "Guided Goals",
    unlockCondition: "Follow a specific medical usage plan for 2 weeks",
    notes: "Encourages alignment with personal health objectives.",
    icon: "clipboard-check",
    complexity: 4
  },
  {
    id: 38,
    category: "Medical-Focused",
    name: "Prescription Partner",
    unlockCondition: "Adhere to provider's recommended usage for 10 sessions, note improvement",
    notes: "Supports medically guided wellness plans.",
    icon: "prescription",
    complexity: 4
  },
  {
    id: 39,
    category: "Recreational-Focused",
    name: "Weekend Wind-Down",
    unlockCondition: "Log usage on Fri/Sat/Sun specifically for leisure/relaxation",
    notes: "Encourages a mindful approach to weekend fun.",
    icon: "calendar-weekend",
    complexity: 2
  },
  {
    id: 40,
    category: "Recreational-Focused",
    name: "Creative Spark",
    unlockCondition: "Log a session that boosted creativity at least 3 times",
    notes: "Fosters purposeful, creative use.",
    icon: "lightbulb-on",
    complexity: 2
  },
  {
    id: 41,
    category: "Recreational-Focused",
    name: "Taste Tester",
    unlockCondition: "Log 5 different variants in a month purely for personal preference",
    notes: "Promotes mindful flavor exploration.",
    icon: "silverware-fork-knife",
    complexity: 3
  },
  {
    id: 42,
    category: "Recreational-Focused",
    name: "Chilled Out Champ",
    unlockCondition: "Log usage for relaxation 5 times in 14 days with mood notes",
    notes: "Rewards fun yet moderate consumption.",
    icon: "sofa",
    complexity: 2
  },
  {
    id: 43,
    category: "Recreational-Focused",
    name: "Social Session",
    unlockCondition: "Mark a session as social/friend-related once a week for 3 weeks",
    notes: "Highlights community aspect in a responsible way.",
    icon: "account-group",
    complexity: 2
  },
  {
    id: 44,
    category: "Recreational-Focused",
    name: "Social Spark",
    unlockCondition: "Log group sessions with improved/shared mood at least 3 times/month",
    notes: "Encourages healthy social enjoyment.",
    icon: "party-popper",
    complexity: 3
  },
  {
    id: 45,
    category: "Recreational-Focused",
    name: "Weekend Warrior",
    unlockCondition: "Log weekend sessions for 4 straight weekends without exceeding personal goals",
    notes: "Proves moderation during leisure times.",
    icon: "shield-outline",
    complexity: 3
  },
  {
    id: 46,
    category: "AI Interaction",
    name: "AI Curious",
    unlockCondition: "Use the AI feature for a personalized suggestion once",
    notes: "Introduces users to advanced app capabilities.",
    icon: "brain",
    complexity: 1
  },
  {
    id: 47,
    category: "AI Interaction",
    name: "AI Explorer",
    unlockCondition: "Follow AI-recommended variants/tips 5 times",
    notes: "Deepens engagement with app's AI resources.",
    icon: "robot",
    complexity: 2
  },
  {
    id: 48,
    category: "AI Interaction",
    name: "Digital Dilemma",
    unlockCondition: "Ask the AI about a symptom or mood goal, log before/after results",
    notes: "Highlights how AI can guide decision-making.",
    icon: "head-question",
    complexity: 2
  },
  {
    id: 49,
    category: "AI Interaction",
    name: "Feedback Fan",
    unlockCondition: "Provide feedback on AI-recommended outcomes at least 3 times",
    notes: "Helps refine AI suggestions; awards extra Variant Points.",
    icon: "message-reply-text",
    complexity: 2
  },
  {
    id: 50,
    category: "Mood & Journaling",
    name: "Mood Logger",
    unlockCondition: "Log your mood (before or after) daily for 7 days",
    notes: "Fosters consistent self-awareness.",
    icon: "emoticon",
    complexity: 2
  },
  {
    id: 51,
    category: "Mood & Journaling",
    name: "Diary Devotee",
    unlockCondition: "Log mood/experience 14 consecutive days",
    notes: "Encourages mindful reflection.",
    icon: "notebook",
    complexity: 3
  },
  {
    id: 52,
    category: "Mood & Journaling",
    name: "Emotional Explorer",
    unlockCondition: "Try 3 different variants and log how each affected your mood",
    notes: "Prompts curiosity about varied experiences.",
    icon: "emoticon-happy",
    complexity: 2
  },
  {
    id: 53,
    category: "Mood & Journaling",
    name: "Mind–Body Balance",
    unlockCondition: "Log a mood/symptom entry with every session for a full week",
    notes: "Promotes deeper introspection and tracking.",
    icon: "scale-balance",
    complexity: 3
  },
  {
    id: 54,
    category: "Referral & Community",
    name: "Spreading the Love",
    unlockCondition: "Refer 1 friend who signs up",
    notes: "Simple step into community-building.",
    icon: "account-plus",
    complexity: 1
  },
  {
    id: 55,
    category: "Referral & Community",
    name: "Community Builder",
    unlockCondition: "Refer 3 friends who sign up",
    notes: "Could award additional Variant Points or discount code.",
    icon: "account-multiple-plus",
    complexity: 2
  },
  {
    id: 56,
    category: "Referral & Community",
    name: "Trend Setter",
    unlockCondition: "Refer 5+ friends who sign up",
    notes: "Early evangelists help grow the user base.",
    icon: "trending-up",
    complexity: 3
  },
  {
    id: 57,
    category: "Referral & Community",
    name: "Grassroots Guru",
    unlockCondition: "Refer 10 friends who each log at least once",
    notes: "'Grassroots' nod to building a larger network.",
    icon: "sprout",
    complexity: 5
  },
  {
    id: 58,
    category: "Referral & Community",
    name: "App Ambassador",
    unlockCondition: "Share app achievements or invites that lead to sign-ups (3+ conversions)",
    notes: "Encourages gentle advocacy without pushing consumption.",
    icon: "medal",
    complexity: 3
  },
  {
    id: 59,
    category: "Morning/Evening Check-Ins",
    name: "Morning Mindfulness",
    unlockCondition: "Log a morning check-in for 7 consecutive days",
    notes: "Helps track how you feel starting each day.",
    icon: "weather-sunset-up",
    complexity: 2
  },
  {
    id: 60,
    category: "Morning/Evening Check-Ins",
    name: "Evening Wind-Down",
    unlockCondition: "Log an evening reflection for 7 consecutive days",
    notes: "Promotes intentional wind-down routines.",
    icon: "weather-sunset-down",
    complexity: 2
  },
  {
    id: 61,
    category: "Morning/Evening Check-Ins",
    name: "Full Day Focus",
    unlockCondition: "Log morning, midday, and evening for 7 consecutive days",
    notes: "Encourages holistic daily awareness.",
    icon: "clock-time-three",
    complexity: 4
  },
  {
    id: 62,
    category: "Long-Term Milestones",
    name: "100 Logs & Counting",
    unlockCondition: "Reach 100 total logged sessions",
    notes: "Marks a substantial data-driven milestone.",
    icon: "counter",
    complexity: 3
  },
  {
    id: 63,
    category: "Long-Term Milestones",
    name: "200 Logs & Counting",
    unlockCondition: "Reach 200 total logged sessions",
    notes: "Shows extended commitment.",
    icon: "numeric-2-circle",
    complexity: 4
  },
  {
    id: 64,
    category: "Long-Term Milestones",
    name: "500 Logs & Counting",
    unlockCondition: "Reach 500 total logged sessions",
    notes: "Could unlock a special theme or discount.",
    icon: "numeric-5-circle",
    complexity: 5
  },
  {
    id: 65,
    category: "Long-Term Milestones",
    name: "Year-Long Legend",
    unlockCondition: "Log usage at least weekly for a full year",
    notes: "Demonstrates mindful tracking over time.",
    icon: "calendar-text",
    complexity: 6
  },
  {
    id: 66,
    category: "Long-Term Milestones",
    name: "Dose Discovery",
    unlockCondition: "Log dosage consistently for 30 days to find personal 'sweet spot'",
    notes: "Promotes balanced consumption habits.",
    icon: "magnify-plus",
    complexity: 4
  },
  {
    id: 67,
    category: "Long-Term Milestones",
    name: "Personal Best",
    unlockCondition: "Achieve a self-set improvement goal (e.g., -20% usage)",
    notes: "Celebrates user-defined success.",
    icon: "star-circle",
    complexity: 3
  },
  {
    id: 68,
    category: "Long-Term Milestones",
    name: "750 Logs & Learning",
    unlockCondition: "Reach 750 total logged sessions",
    notes: "Highlights the insights gained from thorough tracking.",
    icon: "numeric-7-circle",
    complexity: 6
  },
  {
    id: 69,
    category: "Long-Term Milestones",
    name: "1K Commitment",
    unlockCondition: "Surpass 1,000 total logged sessions",
    notes: "Major testament to consistent usage (not higher consumption).",
    icon: "numeric-10-circle",
    complexity: 7
  },
  {
    id: 70,
    category: "Long-Term Milestones",
    name: "Multi-Year Marvel",
    unlockCondition: "Use the app for 2+ years (≥1 log/week or month)",
    notes: "Celebrates ultimate loyalty and mindful engagement.",
    icon: "cake-variant",
    complexity: 7
  },
  {
    id: 71,
    category: "Themed Celebrations",
    name: "Earth Day Eco-Toker",
    unlockCondition: "Log a session on Earth Day with an eco-friendly note or reflection",
    notes: "Encourages environmental consciousness with usage.",
    icon: "earth",
    complexity: 2
  },
  {
    id: 72,
    category: "Themed Celebrations",
    name: "Harvest Hero",
    unlockCondition: "Log a session during autumn harvest season/fall equinox",
    notes: "Seasonal nod to mindful consumption and gratitude.",
    icon: "leaf-maple",
    complexity: 2
  },
  {
    id: 73,
    category: "Themed Celebrations",
    name: "4/20 Festive",
    unlockCondition: "Log on 4/20 while staying within personal goals/limits",
    notes: "Promotes responsible celebration of this cultural day.",
    icon: "calendar-star",
    complexity: 2
  }
];
export const ACHIEVEMENT_TRIGGERS = {
  1: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION, ACHIEVEMENT_ACTION_TYPES.LOG_MOOD],
  2: [ACHIEVEMENT_ACTION_TYPES.CONNECT_DEVICE],
  3: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  4: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  5: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  6: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  7: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  8: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  9: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  10: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  11: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  12: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  13: [ACHIEVEMENT_ACTION_TYPES.SET_GOAL, ACHIEVEMENT_ACTION_TYPES.MEET_GOAL],
  14: [ACHIEVEMENT_ACTION_TYPES.REDUCE_USAGE],
  15: [ACHIEVEMENT_ACTION_TYPES.REDUCE_USAGE],
  16: [ACHIEVEMENT_ACTION_TYPES.MEET_GOAL],
  17: [ACHIEVEMENT_ACTION_TYPES.MEET_GOAL],
  18: [ACHIEVEMENT_ACTION_TYPES.REDUCE_USAGE],
  19: [ACHIEVEMENT_ACTION_TYPES.SET_GOAL, ACHIEVEMENT_ACTION_TYPES.MEET_GOAL],
  20: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT],
  21: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT],
  22: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT],
  23: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT],
  24: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT],
  25: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT],
  26: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT],
  27: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT],
  28: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT],
  29: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT],
  30: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT],
  31: [ACHIEVEMENT_ACTION_TYPES.TRACK_SYMPTOMS, ACHIEVEMENT_ACTION_TYPES.LOG_MOOD],
  32: [ACHIEVEMENT_ACTION_TYPES.TRACK_SYMPTOMS, ACHIEVEMENT_ACTION_TYPES.LOG_MOOD],
  33: [ACHIEVEMENT_ACTION_TYPES.TRACK_SYMPTOMS, ACHIEVEMENT_ACTION_TYPES.LOG_MOOD],
  34: [ACHIEVEMENT_ACTION_TYPES.TRACK_SYMPTOMS],
  35: [ACHIEVEMENT_ACTION_TYPES.TRACK_SYMPTOMS, ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  36: [ACHIEVEMENT_ACTION_TYPES.TRACK_SYMPTOMS],
  37: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION, ACHIEVEMENT_ACTION_TYPES.TRACK_SYMPTOMS],
  38: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION, ACHIEVEMENT_ACTION_TYPES.TRACK_SYMPTOMS],
  39: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION, ACHIEVEMENT_ACTION_TYPES.LOG_MOOD],
  40: [ACHIEVEMENT_ACTION_TYPES.LOG_MOOD],
  41: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT],
  42: [ACHIEVEMENT_ACTION_TYPES.LOG_MOOD, ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  43: [ACHIEVEMENT_ACTION_TYPES.LOG_MOOD, ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  44: [ACHIEVEMENT_ACTION_TYPES.LOG_MOOD, ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  45: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION, ACHIEVEMENT_ACTION_TYPES.MEET_GOAL],
  46: [ACHIEVEMENT_ACTION_TYPES.USE_AI],
  47: [ACHIEVEMENT_ACTION_TYPES.USE_AI],
  48: [ACHIEVEMENT_ACTION_TYPES.USE_AI, ACHIEVEMENT_ACTION_TYPES.LOG_MOOD],
  49: [ACHIEVEMENT_ACTION_TYPES.USE_AI],
  50: [ACHIEVEMENT_ACTION_TYPES.LOG_MOOD],
  51: [ACHIEVEMENT_ACTION_TYPES.LOG_MOOD],
  52: [ACHIEVEMENT_ACTION_TYPES.LOG_VARIANT, ACHIEVEMENT_ACTION_TYPES.LOG_MOOD],
  53: [ACHIEVEMENT_ACTION_TYPES.LOG_MOOD, ACHIEVEMENT_ACTION_TYPES.TRACK_SYMPTOMS, ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  54: [ACHIEVEMENT_ACTION_TYPES.REFER_FRIEND],
  55: [ACHIEVEMENT_ACTION_TYPES.REFER_FRIEND],
  56: [ACHIEVEMENT_ACTION_TYPES.REFER_FRIEND],
  57: [ACHIEVEMENT_ACTION_TYPES.REFER_FRIEND],
  58: [ACHIEVEMENT_ACTION_TYPES.REFER_FRIEND],
  59: [ACHIEVEMENT_ACTION_TYPES.TRACK_MORNING],
  60: [ACHIEVEMENT_ACTION_TYPES.TRACK_EVENING],
  61: [ACHIEVEMENT_ACTION_TYPES.TRACK_MORNING, ACHIEVEMENT_ACTION_TYPES.TRACK_EVENING, ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  62: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  63: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  64: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  65: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  66: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  67: [ACHIEVEMENT_ACTION_TYPES.REDUCE_USAGE, ACHIEVEMENT_ACTION_TYPES.MEET_GOAL],
  68: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  69: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  70: [ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  71: [ACHIEVEMENT_ACTION_TYPES.CHECK_DATE, ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  72: [ACHIEVEMENT_ACTION_TYPES.CHECK_DATE, ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION],
  73: [ACHIEVEMENT_ACTION_TYPES.CHECK_DATE, ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION]
};
export const SESSION_DETECTION_CONFIG = {
  SESSION_GAP_HOURS: 4,           
  MIN_HITS_PER_SESSION: 1,        
};
export const QR_FEATURE_MESSAGES = {
  LIMITATION_NOTICE: "NOTE: This feature expects QR codes to link to a JSON endpoint. Directly scanning COA webpages or PDFs is a future backend enhancement.",
  LIMITATION_SHORT: "QR codes must link to JSON endpoints. COA webpage/PDF support coming soon."
} as const;