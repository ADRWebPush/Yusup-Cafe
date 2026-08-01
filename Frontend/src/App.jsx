'use client'
import React, { useState, useEffect, useMemo, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { AnimatePresence, LayoutGroup, motion, useAnimationControls, useReducedMotion } from "motion/react";
import { salesTotalsForPeriods } from "./adminAnalytics.js";
import {
  LEGACY_LOYALTY_TOKEN_KEY,
  LOYALTY_CODE_KEY,
  LOYALTY_DEVICE_KEY,
  bonusEarnPreview,
  bonusSpendLimit,
  clampBonusUse,
  isValidLoyaltyCode,
  normalizeLoyaltyCodeInput,
} from "./loyalty.js";
import {
  MOTION,
  menuItemVariants,
  reducedSectionVariants,
  sectionChildVariants,
  sectionVariants,
  useAmbientVisibility,
  useCartFlight,
} from "./motionSystem.js";

/* ───────────────────────── Yusup Cafe ─────────────────────────
   Guest site + Admin panel in one app.
   Shared persistent storage: menu + orders are visible to everyone
   who opens this artifact (that's what makes guest → kitchen work).
   Admin PIN: 1234
──────────────────────────────────────────────────────────────────────────── */

const MENU_KEY = "aspan-menu-v1";
const ORDERS_KEY = "aspan-orders-v1";
const KASPI_KEY = "aspan-kaspi-qr-v1";
const ADMIN_PIN = "1234";

// Palette drawn straight from the Yusup Cafe seal: deep burgundy field,
// near-black inner disc, ivory type and laurel, with brass/saffron as the
// warm accent. Key names are kept from the previous brand so every inline
// style updates automatically — only the values changed. `teal` is the
// primary action colour (burgundy), `saff` the brass highlight.
const P = {
  ink: "#2B1B1C", ink2: "#1A1011", bone: "#FAF5EC", card: "#FFFDF8",
  line: "#EEE2D2", teal: "#742427", tealD: "#5D1C20", saff: "#C99A5A",
  red: "#B23A2F", green: "#5C8544", txt: "#241819", sub: "#776960",
  brand: "#742427", // Yusup Cafe seal burgundy
};

// Cormorant Garamond for display type — the seal's serif wordmark reads as a
// classic garamond, and Cormorant ships a Cyrillic subset, so Russian and
// Kazakh headlines render in the same face instead of falling back.
const FONT_DISPLAY = "'Cormorant Garamond',Georgia,'Times New Roman',serif";
const FONT_BODY = "'Manrope',system-ui,-apple-system,sans-serif";

// Order matches the physical menu's page sequence (coffee page → sides/
// breakfast/cold-coffee page → sushi bar page → mains/pizza/fast-food page).
const CATS = [
  { id: "combo", en: "Skewer combos", ru: "Шашлык комбо", kz: "Шашлық комбо", tint: "#F6E2DD" },
  { id: "shashlyk", en: "Skewers", ru: "Шашлык", kz: "Шашлық", tint: "#EFE1D4" },
  { id: "soups", en: "First courses", ru: "Первые блюда", kz: "Бірінші тағамдар", tint: "#F5E5DB" },
  { id: "mains", en: "Main courses", ru: "Вторые блюда", kz: "Негізгі тағамдар", tint: "#EDE3D3" },
  { id: "salads", en: "Salads", ru: "Салаты", kz: "Салаттар", tint: "#E9E8D8" },
  { id: "cold", en: "Cold drinks", ru: "Холодные напитки", kz: "Салқын сусындар", tint: "#EAE3D9" },
  { id: "hot", en: "Hot drinks", ru: "Горячие напитки", kz: "Ыстық сусындар", tint: "#EFE1D4" },
];

const TAGS = {
  hit: { en: "Hit", ru: "Хит", kz: "Хит", bg: "#F4E5E2", fg: "#742427" },
  new: { en: "New", ru: "Новинка", kz: "Жаңа", bg: "#F8ECCF", fg: "#8F6512" },
  veg: { en: "Veg", ru: "Вег", kz: "Вег", bg: "#E9F1DF", fg: "#3F7A2E" },
  spicy: { en: "Spicy", ru: "Острое", kz: "Ащы", bg: "#FAE5E3", fg: "#A5382A" },
};

const STATUS = {
  pending: { en: "Pending confirmation", ru: "Ожидает подтверждения", kz: "Растауды күтуде", bg: "#E6E0D2", fg: "#241819" },
  awaiting_confirmation: { en: "Awaiting payment", ru: "Ожидает оплаты", kz: "Төлемді күтуде", bg: "#FBEFD9", fg: "#8A5A12" },
  new: { en: "New", ru: "Новый", kz: "Жаңа", bg: "#EDE6DC", fg: "#5D4F49" },
  cooking: { en: "In the kitchen", ru: "Готовится", kz: "Дайындалуда", bg: "#FBEFD9", fg: "#8A5A12" },
  ready: { en: "Ready", ru: "Готов", kz: "Дайын", bg: "#E9F1DF", fg: "#3F7A2E" },
  done: { en: "Completed", ru: "Завершён", kz: "Аяқталды", bg: "#EFECE6", fg: "#7C7468" },
  cancelled: { en: "Cancelled", ru: "Отменён", kz: "Болдырылмады", bg: "#FAE5E3", fg: "#A5382A" },
};

const SEED = [
  { id: "combo1", cat: "combo", emoji: "🍢", price: 14500, tags: ["hit"], available: true,
    name: { en: "Combo 1", ru: "Комбо 1", kz: "Комбо 1" },
    desc: { en: "5 duck, 5 chicken, 5 lamb, 10 minced · +2 sauces · 25 skewers", ru: "5 утка, 5 куриный, 5 кусковой, 10 фарш · +2 соуса · 25 палочек", kz: "5 үйрек, 5 тауық, 5 кесек ет, 10 фарш · +2 соус · 25 таяқша" } },
  { id: "combo2", cat: "combo", emoji: "🍢", price: 14000, tags: [], available: true,
    name: { en: "Combo 2", ru: "Комбо 2", kz: "Комбо 2" },
    desc: { en: "5 duck, 5 chicken, 1 chicken portion, 10 minced · +2 sauces · 20 skewers", ru: "5 утка, 5 куриный, 1 порц. чикен, 10 фарш · +2 соуса · 20 палочек", kz: "5 үйрек, 5 тауық, 1 порц. чикен, 10 фарш · +2 соус · 20 таяқша" } },
  { id: "combo3", cat: "combo", emoji: "🍢", price: 15000, tags: [], available: true,
    name: { en: "Combo 3", ru: "Комбо 3", kz: "Комбо 3" },
    desc: { en: "20 minced · +2 white sauces · 20 skewers", ru: "20 фарш · +2 белых соуса · 20 палочек", kz: "20 фарш · +2 ақ соус · 20 таяқша" } },
  { id: "combo4", cat: "combo", emoji: "🍢", price: 17000, tags: [], available: true,
    name: { en: "Combo 4", ru: "Комбо 4", kz: "Комбо 4" },
    desc: { en: "10 duck, 10 chicken, 10 minced · +2 sauces · 30 skewers", ru: "10 утка, 10 куриный, 10 фарш · +2 соуса · 30 палочек", kz: "10 үйрек, 10 тауық, 10 фарш · +2 соус · 30 таяқша" } },
  { id: "combomax", cat: "combo", emoji: "🔥", price: 27000, tags: ["hit"], available: true,
    name: { en: "Combo PRO MAX", ru: "Комбо PRO MAX", kz: "Комбо PRO MAX" },
    desc: { en: "10 duck, 10 chicken, 10 lamb, 10 minced, 1.5 chicken · +2 white +3 sauces · 40 skewers", ru: "10 утка, 10 куриный, 10 кусковой, 10 фарш, 1.5 порц. чикен · +2 бел. +3 соуса · 40 палочек", kz: "10 үйрек, 10 тауық, 10 кесек ет, 10 фарш, 1.5 чикен · +2 ақ +3 соус · 40 таяқша" } },
  { id: "sh_utka", cat: "shashlyk", emoji: "🦆", price: 600, tags: [], available: true,
    name: { en: "Duck skewer", ru: "Шашлык из утки", kz: "Үйрек шашлық" },
    desc: { en: "One skewer", ru: "Одна палочка", kz: "Бір таяқша" } },
  { id: "sh_kur", cat: "shashlyk", emoji: "🍗", price: 600, tags: [], available: true,
    name: { en: "Chicken skewer", ru: "Куриный шашлык", kz: "Тауық шашлық" },
    desc: { en: "One skewer", ru: "Одна палочка", kz: "Бір таяқша" } },
  { id: "sh_kus", cat: "shashlyk", emoji: "🥩", price: 700, tags: [], available: true,
    name: { en: "Lamb chunk skewer", ru: "Кусковой шашлык", kz: "Кесек ет шашлық" },
    desc: { en: "One skewer", ru: "Одна палочка", kz: "Бір таяқша" } },
  { id: "sh_farsh", cat: "shashlyk", emoji: "🍢", price: 600, tags: [], available: true,
    name: { en: "Minced skewer (lyulya)", ru: "Шашлык из фарша (люля)", kz: "Фарш шашлық" },
    desc: { en: "One skewer", ru: "Одна палочка", kz: "Бір таяқша" } },
  { id: "sh_chiken", cat: "shashlyk", emoji: "🍗", price: 800, tags: [], available: true,
    name: { en: "Chicken (chiken)", ru: "Чикен", kz: "Чикен" },
    desc: { en: "Portion", ru: "Порция", kz: "Порция" } },
  { id: "fc_sorpa", cat: "soups", emoji: "🍲", price: 1000, priceMax: 1200, tags: [], available: true,
    name: { en: "Sorpa (broth)", ru: "Сорпа", kz: "Сорпа" },
    desc: { en: "Rich meat broth", ru: "Наваристый мясной бульон", kz: "Қою ет сорпасы" } },
  { id: "fc_pelmeni", cat: "soups", emoji: "🥟", price: 1200, priceMax: 1400, tags: [], available: true,
    name: { en: "Pelmeni", ru: "Пельмени", kz: "Пельмень" },
    desc: { en: "Meat dumplings in broth", ru: "Мясные пельмени в бульоне", kz: "Сорпадағы ет пельмень" } },
  { id: "fc_suyru", cat: "soups", emoji: "🍜", price: 1200, priceMax: 1400, tags: [], available: true,
    name: { en: "Suyru lagman (soup)", ru: "Сүйру лагман", kz: "Сүйру лағман" },
    desc: { en: "Hand-pulled noodle soup", ru: "Суп с домашней лапшой", kz: "Үй кеспесі бар сорпа" } },
  { id: "fc_kuksu", cat: "soups", emoji: "🍜", price: 1200, priceMax: 1400, tags: [], available: true,
    name: { en: "Kuksu", ru: "Куксу", kz: "Куксу" },
    desc: { en: "Cold noodle soup", ru: "Холодный суп с лапшой", kz: "Салқын кеспе сорпасы" } },
  { id: "fc_naryn", cat: "soups", emoji: "🍜", price: 1300, priceMax: 1500, tags: [], available: true,
    name: { en: "Naryn", ru: "Нарын", kz: "Нарын" },
    desc: { en: "Noodles with horse meat", ru: "Лапша с кониной", kz: "Жылқы етімен кеспе" } },
  { id: "mc_manty", cat: "mains", emoji: "🥟", price: 1400, tags: [], available: true,
    name: { en: "Manty", ru: "Манты", kz: "Манты" },
    desc: { en: "Steamed meat dumplings", ru: "Паровые манты с мясом", kz: "Буға пісірілген манты" } },
  { id: "mc_tefteli", cat: "mains", emoji: "🍖", price: 1800, tags: [], available: true,
    name: { en: "Meatballs", ru: "Тефтели", kz: "Тефтели" },
    desc: { en: "Meatballs in sauce", ru: "Тефтели в соусе", kz: "Соустағы тефтели" } },
  { id: "mc_brizol", cat: "mains", emoji: "🍳", price: 1600, tags: [], available: true,
    name: { en: "Brizol", ru: "Бризоль", kz: "Бризоль" },
    desc: { en: "Meat in an omelette wrap", ru: "Мясо в яичном блинчике", kz: "Жұмыртқа қабығындағы ет" } },
  { id: "mc_guyru", cat: "mains", emoji: "🍜", price: 1600, tags: [], available: true,
    name: { en: "Fried lagman", ru: "Гуйру лагман", kz: "Гуйру лағман" },
    desc: { en: "Stir-fried noodles with meat", ru: "Жареная лапша с мясом", kz: "Етпен қуырылған кеспе" } },
  { id: "mc_comyan", cat: "mains", emoji: "🍜", price: 1600, tags: [], available: true,
    name: { en: "Tsomyan (fried noodles)", ru: "Цомян", kz: "Цомян" },
    desc: { en: "Uyghur-style fried noodles", ru: "Жареная лапша по-уйгурски", kz: "Ұйғырша қуырылған кеспе" } },
  { id: "mc_bifshteks", cat: "mains", emoji: "🥩", price: 1600, tags: [], available: true,
    name: { en: "Beefsteak", ru: "Бифштекс", kz: "Бифштекс" },
    desc: { en: "Pan-fried beef patty", ru: "Жареный говяжий бифштекс", kz: "Қуырылған сиыр бифштексі" } },
  { id: "mc_gulyash", cat: "mains", emoji: "🍲", price: 1600, tags: [], available: true,
    name: { en: "Goulash", ru: "Гуляш", kz: "Гуляш" },
    desc: { en: "Beef stew with gravy", ru: "Гуляш из говядины с подливой", kz: "Тұздықпен сиыр гуляшы" } },
  { id: "mc_plov", cat: "mains", emoji: "🍛", price: 1600, tags: ["hit"], available: true,
    name: { en: "Plov", ru: "Плов", kz: "Палау" },
    desc: { en: "Rice with meat and carrots", ru: "Рис с мясом и морковью", kz: "Ет пен сәбізі бар күріш" } },
  { id: "mc_tabaka", cat: "mains", emoji: "🍗", price: 1700, tags: [], available: true,
    name: { en: "Chicken tabaka", ru: "Табака цыплята", kz: "Тапақа балапан" },
    desc: { en: "Flattened fried chicken", ru: "Цыпленок табака", kz: "Жалпақталған қуырылған балапан" } },
  { id: "mc_kazan", cat: "mains", emoji: "🍖", price: 2300, tags: ["hit"], available: true,
    name: { en: "Kazan kebab", ru: "Казан кебаб", kz: "Қазан кебаб" },
    desc: { en: "Meat and potatoes from the cauldron", ru: "Мясо с картофелем из казана", kz: "Қазандағы ет пен картоп" } },
  { id: "mc_beshbarmak", cat: "mains", emoji: "🍲", price: 2300, tags: ["hit"], available: true,
    name: { en: "Beshbarmak", ru: "Бешбармак", kz: "Бешбармақ" },
    desc: { en: "Boiled meat with flat noodles", ru: "Отварное мясо с домашней лапшой", kz: "Қайнатылған ет пен қамыр" } },
  { id: "sl_achuchuk", cat: "salads", emoji: "🥗", price: 850, tags: [], available: true,
    name: { en: "Achuchuk", ru: "Ачучук", kz: "Ашшық-чучук" },
    desc: { en: "Tomato and onion salad", ru: "Салат из томатов и лука", kz: "Қызанақ пен пияз салаты" } },
  { id: "sl_svezhiy", cat: "salads", emoji: "🥗", price: 850, tags: [], available: true,
    name: { en: "Fresh salad", ru: "Свежий", kz: "Балғын салат" },
    desc: { en: "Fresh vegetables", ru: "Салат из свежих овощей", kz: "Балғын көкөніс салаты" } },
  { id: "sl_thai", cat: "salads", emoji: "🥗", price: 1350, tags: [], available: true,
    name: { en: "Thai salad", ru: "Тайский", kz: "Тай салаты" },
    desc: { en: "Thai-style salad", ru: "Салат по-тайски", kz: "Тайша салат" } },
  { id: "sl_kapriz", cat: "salads", emoji: "🥗", price: 1350, tags: [], available: true,
    name: { en: "Men's caprice", ru: "Мужской каприз", kz: "Ер каприз" },
    desc: { en: "Meat salad with vegetables", ru: "Мясной салат с овощами", kz: "Көкөніспен ет салаты" } },
  { id: "sl_cezar", cat: "salads", emoji: "🥗", price: 1350, tags: [], available: true,
    name: { en: "Caesar", ru: "Цезарь", kz: "Цезарь" },
    desc: { en: "Caesar with chicken", ru: "Цезарь с курицей", kz: "Тауықпен цезарь" } },
  { id: "sl_yusup", cat: "salads", emoji: "🥗", price: 1500, tags: ["hit"], available: true,
    name: { en: "Yusup salad", ru: "Юсуп салат", kz: "Юсуп салаты" },
    desc: { en: "House special salad", ru: "Фирменный салат заведения", kz: "Мекеменің фирмалық салаты" } },
  { id: "cd_cola", cat: "cold", emoji: "🥤", price: 300, tags: [], available: true,
    name: { en: "Coca-Cola", ru: "Кока-Кола", kz: "Кока-Кола" },
    desc: { en: "Chilled", ru: "Охлажденная", kz: "Салқындатылған" } },
  { id: "cd_maxi", cat: "cold", emoji: "🥤", price: 400, tags: [], available: true,
    name: { en: "Maxi cola", ru: "Макси кола", kz: "Макси кола" },
    desc: { en: "Large serving", ru: "Большая порция", kz: "Үлкен порция" } },
  { id: "cd_fanta", cat: "cold", emoji: "🥤", price: 250, tags: [], available: true,
    name: { en: "Fanta", ru: "Фанта", kz: "Фанта" },
    desc: { en: "Chilled", ru: "Охлажденная", kz: "Салқындатылған" } },
  { id: "cd_fuse", cat: "cold", emoji: "🧃", price: 250, tags: [], available: true,
    name: { en: "Fuse Tea", ru: "Фьюс чай", kz: "Фьюс шай" },
    desc: { en: "Iced tea", ru: "Холодный чай", kz: "Салқын шай" } },
  { id: "hd_black", cat: "hot", emoji: "🍵", price: 300, tags: [], available: true,
    name: { en: "Black tea", ru: "Чёрный чай", kz: "Қара шай" },
    desc: { en: "Pot of black tea", ru: "Чайник черного чая", kz: "Бір шәйнек қара шай" } },
  { id: "hd_green", cat: "hot", emoji: "🍵", price: 300, tags: [], available: true,
    name: { en: "Green tea", ru: "Зелёный чай", kz: "Жасыл шай" },
    desc: { en: "Pot of green tea", ru: "Чайник зеленого чая", kz: "Бір шәйнек жасыл шай" } },
  { id: "hd_tashkent", cat: "hot", emoji: "🍵", price: 400, tags: [], available: true,
    name: { en: "Tashkent tea", ru: "Ташкентский чай", kz: "Ташкент шайы" },
    desc: { en: "Tashkent-style tea", ru: "Чай по-ташкентски", kz: "Ташкентше шай" } },
  { id: "hd_coffee", cat: "hot", emoji: "☕", price: 250, tags: [], available: true,
    name: { en: "Coffee", ru: "Кофе", kz: "Кофе" },
    desc: { en: "Freshly brewed", ru: "Свежесваренный", kz: "Жаңа қайнатылған" } },
];

// Table reservations by capacity. Field keys (id/name/capacity) are kept the
// same shape the booking payload + admin card already expect, so only the
// user-facing content changed from the old hall/room list.
const TABLES = [
  { id: "t4", name: { en: "Table for up to 4", ru: "Столик до 4 человек", kz: "4 адамға дейінгі столик" }, capacity: 4, emoji: "🍽" },
  { id: "t8", name: { en: "Table for up to 8", ru: "Столик до 8 человек", kz: "8 адамға дейінгі столик" }, capacity: 8, emoji: "🍽" },
  { id: "t12", name: { en: "Table for up to 12", ru: "Столик до 12 человек", kz: "12 адамға дейінгі столик" }, capacity: 12, emoji: "🍽" },
  { id: "t16", name: { en: "Table for up to 16", ru: "Столик до 16 человек", kz: "16 адамға дейінгі столик" }, capacity: 16, emoji: "🍽" },
  { id: "t20", name: { en: "Table for up to 20", ru: "Столик до 20 человек", kz: "20 адамға дейінгі столик" }, capacity: 20, emoji: "🍽" },
  { id: "t25", name: { en: "Table for up to 25", ru: "Столик до 25 человек", kz: "25 адамға дейінгі столик" }, capacity: 25, emoji: "🍽" },
  { id: "t30", name: { en: "Table for up to 30", ru: "Столик до 30 человек", kz: "30 адамға дейінгі столик" }, capacity: 30, emoji: "🍽" },
];

// Curated from the cafe's public gallery. Keep this intentionally limited to
// dishes with a clear visual match; an admin-uploaded image always wins.
const GALLERY_MENU_IMAGES = {
  lm1: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/HZAOoqDCSb3PCWch49o1e.jpg",
  lm3: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/7ze2CeFwzE2Qr0ZntNSfI.jpg",
  lm5: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/9DmwkVzbE4NGGTlrj5S93.jpg",
  lm7: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/jEKDYQqUPGdpXPrnFfNEQ.jpg",
  lm9: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/j_wltOsbscnEBQmi6lqGy.jpg",
  lm11: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/eRy6Zfc86vuX1C1z09NLA.jpg",
  so1: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/vmATeFt4WSfqJeDANfmI7.jpg",
  mn1: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/BqRUNgAkc1k1GaXiGnEiO.jpg",
  sl1: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/Cyg4lpKIBfLd3kmKXhY7c.jpg",
  s2: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/PMaEwii2CdXS8fuzx2xBO.jpg",
  pz2: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/ECnyT924GVlsgeA7c2e1M.jpg",
  pz6: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/vVYNFZi64F1Gu4tGOHjjJ.jpg",
  ff3: "https://storage.vigbo.tech/p/s768/gallery-photo/80873820-bdc6-4495-8968-842e4017fb37/b4eb7fa7-c765-4ec4-8250-10265e246fd6/original/uJsH0YeMp6BeURI29Q7aq.jpg",
};

const TIME_SLOTS = ["10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"];

// ── Delayed-fulfillment timing (compute-only; staff still press "В работу") ──
// Defaults used to show staff roughly when a scheduled order should hit the
// kitchen: target time minus cooking (minus delivery travel for delivery).
const DEFAULT_COOK_MIN = 20;
const DELIVERY_TRAVEL_MIN = 30;

// The requested target moment (pickup / delivery / arrival) as an ms timestamp,
// from an explicit schedule or, for bookings, the reservation date+time.
function orderScheduledFor(o) {
  if (o.scheduledFor) return o.scheduledFor;
  if (o.type === "booking" && o.booking && o.booking.date && o.booking.time) {
    const ms = Date.parse(`${o.booking.date}T${o.booking.time}:00`);
    return isNaN(ms) ? null : ms;
  }
  return null;
}

// When the kitchen should start cooking so the order is ready on time.
function orderStartCookAt(o) {
  const target = orderScheduledFor(o);
  if (!target) return null;
  const travel = o.type === "delivery" ? DELIVERY_TRAVEL_MIN : 0;
  return target - (DEFAULT_COOK_MIN + travel) * 60000;
}

// A "pre-order": scheduled for the future and not yet started by staff. These
// are shown in a separate admin section so the live queue stays clean.
function isFutureScheduled(o, now = Date.now()) {
  const startAt = orderStartCookAt(o);
  return startAt != null && startAt > now &&
    (o.status === "new" || o.status === "awaiting_confirmation");
}

const T = {
  en: {
    menu: "Menu", about: "About", contacts: "Contacts", cart: "Cart",
    tagline: "Where grill smoke and the aroma of chicken drift, the most genuine people always gather.",
    heroText: "Pizza, sushi, burgers, coffee and more — a wide menu, always fresh and homely. Sairam, Shymkent.",
    seeMenu: "Open the menu", today: "Open today", until: "until",
    search: "Search the menu…", all: "All", soldOut: "Sold out", add: "Add",
    cartEmpty: "Your cart is empty", cartEmptyHint: "Add something from the menu — it will appear here.",
    total: "Total", checkout: "Checkout", back: "Back",
    subtotal: "Subtotal", serviceFee: "Service fee (10%)", totalToPay: "Total to pay",
    privacyPolicy: "Privacy Policy", consentPrefix: "I agree with the ", consentSuffix: "",
    consentNeed: "Please agree to the Privacy Policy to continue.",
    orderType: "Where do we serve it?", atTable: "To my table", pickup: "Pickup",
    delivery: "Delivery", atTableShort: "To table",
    gpsOptional: "I'm here now — attach GPS (optional)", locating: "Locating…",
    gpsBtn: "My location", open2gis: "Open 2GIS",
    mapPickBtn: "Point on the map", mapPickTitle: "Where should the courier go?",
    mapPickHint: "Move the map so the pin sits on your building.",
    mapPickDone: "Deliver here", mapPickLoading: "Determining address…",
    deliveryFeeLbl: "Delivery", deliveryFree: "Free delivery",
    deliveryTooFar: "Unfortunately, this point is outside our delivery area.",
    inclInTotal: "added to the total", needPin: "Choose your delivery point on the map.",
    addrDetailsNote: "Apartment, entrance and floor — please add them in the comment below.",
    gisHint: "Find your spot in 2GIS, then type the address above — or paste a 2GIS share link below.",
    gisLinkLabel: "2GIS location link (optional)",
    gpsAttached: "Precise location attached", courierCall: "The courier will call this number before arrival.",
    addrText: "Delivery address", addrPh: "Street, building, apartment, entrance, floor — e.g. Turan 37, apt 12, entrance 2, floor 4",
    needLoc: "Please type your delivery address so the courier can find you.",
    placedDelivery: "The courier is on the way. We will call before arrival.",
    openMap: "Open in 2GIS", openMapG: "Google",
    tableNo: "Table number", yourName: "Your name", phone: "Phone",
    comment: "Comment (optional)", commentPh: "Allergies, no sugar, extra hot…",
    placeOrder: "Place order", needTable: "Enter your table number (it is on the QR stand).",
    needContacts: "Enter your name and phone so we can call when it is ready.",
    placed: "Order accepted!", placedTable: "We are already on it — we will bring it to table",
    placedPickup: "We will call you when it is ready to pick up.",
    orderNo: "Order", statusNow: "Current status", refresh: "Refresh order status",
    newOrder: "New order", aboutTitle: "A cafe about the steppe, made urban",
    aboutText: "Yusup Cafe is the restaurant of your dreams in Shymkent. Pizza, sushi, burgers, kebabs, coffee and desserts — all in one place, always fresh, filling and homely, every day from 08:00 to 01:00.",
    addressT: "Address", hoursT: "Hours", phoneT: "Phone",
    address: "Yusuf Saremi St. 964, Vahab Ata Mall, Sairam, Shymkent", hours: "Daily · 08:00–01:00",
    staff: "Staff portal",
    activeOrder: "Your order", items: "items",
    footAbout: "Where grill smoke and the aroma of chicken drift, the most genuine people always gather.",
    payBtn: "Pay", payTitle: "Payment via Kaspi", payAmount: "Order total",
    kaspiScan: "Scan this QR in the Kaspi app", kaspiNoQr: "The cafe's Kaspi QR will appear here",
    kaspiStep1: "Open Kaspi → Payments → Scan QR", kaspiStep2: "Transfer the exact order total",
    kaspiStep3: "Then tap “I paid” below", iPaid: "I paid", kaspiNote: "Pay directly to the cafe via Kaspi",
    cancelPay: "Cancel", awaitingNote: "Waiting for the cafe to confirm your Kaspi payment. The kitchen starts once confirmed.",
    book: "Book a table", bookRoom: "Reserve a table", rooms: "Tables", upTo: "Up to",
    people: "guests", pickRoom: "Choose a table", whenVisit: "When are you coming?",
    date: "Date", time: "Time", guests: "Guests", next: "Next", chooseTime: "Pick a time slot",
    yourPhone: "Your phone", phoneNote: "We'll call to confirm the details of your reservation.",
    needPhone: "Please enter a valid phone number.",
    preOrderTitle: "Pre-order food in advance?",
    preOrderNote: "Dishes like plov and quyrdaq take 2–3 hours to cook. Order ahead so nothing keeps you waiting when you arrive!",
    goToMenu: "Choose dishes", skipFood: "Just book the table",
    bookingFor: "Reservation", roomOnly: "Table only — no food pre-ordered",
    allTablesStopped: "Reservations are temporarily unavailable.",
    whenLabel: "When to serve it?", asap: "As soon as possible", forTime: "For a specific time",
    schedPast: "Please choose a time later than now.",
    schedFor: "Scheduled for", startCookApprox: "Start cooking ~",
    schedSection: "Scheduled pre-orders", activeSection: "Active now",
    callConfirm: "Phone confirmation required", callConfirmNote: "Call the customer to confirm the reservation before starting.",
    callDone: "Confirmed by phone",
    booked: "Booked", tooSmall: "Too small", checking: "checking…",
    busyAtTime: "Busy at this time", slotTaken: "Sorry, this time was just taken — please pick another time.",
    bookingPay: "To confirm the reservation, pay a deposit / the pre-order total via Kaspi.",
    confirmBooking: "Confirm reservation",
    bookNoPay: "Book now (Pay at cafe)",
    placeOrderFinal: "Place order (Pay at cafe)",
    addrConfirmNote: "Please double-check your address above. If anything looks wrong, edit it before sending.",
    tlTitle: "Order progress", tlReceived: "Order received", tlPreparing: "Preparing",
    tlReady: "Ready", tlDone: "Completed", tlCancelled: "Cancelled", minShort: "min",
    beingPrepared: "Your order is being prepared", estRemaining: "Estimated time remaining",
    prepReadyRestaurant: "Restaurant readiness: approximately", prepReadyOrder: "Order readiness: approximately",
    deliveryTimeNote: "Delivery time is not included and depends on the courier and traffic conditions.",
    almostReady: "Almost ready — any moment now", notifTitle: "Notifications",
    ntfCooking: "Your order is being prepared. Estimated time: {m} minutes.",
    ntfCookingNoTime: "Your order is being prepared.",
    ntfReady: "Your order is ready.", ntfDone: "Order completed. Thank you.",
    ntfCancelled: "Your order has been cancelled.",
    ntfCallConfirmed: "Your reservation is confirmed. See you soon!",
    bookingConfirmed: "Reservation confirmed by the cafe",
    allOrders: "Orders", boardTitle: "Find your order",
    boardEmpty: "No active orders right now",
    boardHint: "Tap your order number to see the details.",
    backToList: "All orders",
    payKaspi: "Pay via Kaspi", openKaspi: "Open Kaspi",
    kaspiAmount: "Amount to pay",
    kaspiComment: "Add your order number in the transfer comment",
    orderFailed: "Could not send the order. Please try again.",
    ntfConfirmed: "Payment confirmed. Your order has been sent to the kitchen.",
    cafeClosedAlert: "The cafe is not operating right now, so we can't take orders at the moment. Please try again during working hours.",
    takeawayUnavailable: "{items} cannot be ordered for delivery or pickup.",
  },
  ru: {
    menu: "Меню", about: "О нас", contacts: "Контакты", cart: "Корзина",
    tagline: "Там, где дым от шашлыка и аромат чикена, всегда собираются самые искренние люди.",
    heroText: "Пицца, суши, бургеры, кофе и не только — большое меню, всегда свежее и уютное. Сайрам, Шымкент.",
    seeMenu: "Открыть меню", today: "Сегодня открыто", until: "до",
    search: "Поиск по меню…", all: "Все", soldOut: "Стоп-лист", add: "Добавить",
    cartEmpty: "Корзина пуста", cartEmptyHint: "Добавьте что-нибудь из меню — оно появится здесь.",
    total: "Итого", checkout: "Оформить заказ", back: "Назад",
    subtotal: "Стоимость блюд", serviceFee: "Обслуживание: 10%", totalToPay: "Итого к оплате",
    privacyPolicy: "Политикой конфиденциальности", consentPrefix: "Я согласен(а) с ", consentSuffix: "",
    consentNeed: "Пожалуйста, подтвердите согласие с Политикой конфиденциальности.",
    orderType: "Куда подать?", atTable: "За мой столик", pickup: "С собой",
    delivery: "Доставка", atTableShort: "За столик",
    gpsOptional: "Я сейчас здесь — прикрепить GPS (необязательно)", locating: "Определяем…",
    gpsBtn: "Моя геолокация", open2gis: "Открыть 2ГИС",
    mapPickBtn: "Указать на карте", mapPickTitle: "Куда приехать курьеру?",
    mapPickHint: "Передвиньте карту так, чтобы точка была на вашем доме.",
    mapPickDone: "Доставить сюда", mapPickLoading: "Определяем адрес…",
    deliveryFeeLbl: "Доставка", deliveryFree: "Бесплатная доставка",
    deliveryTooFar: "К сожалению, эта точка вне зоны доставки.",
    inclInTotal: "добавлено к итогу", needPin: "Укажите точку доставки на карте.",
    addrDetailsNote: "Квартиру, подъезд и этаж укажите, пожалуйста, в комментарии ниже.",
    gisHint: "Найдите место в 2ГИС и впишите адрес выше — или вставьте ссылку из 2ГИС ниже.",
    gisLinkLabel: "Ссылка из 2ГИС (необязательно)",
    gpsAttached: "Точная геолокация прикреплена", courierCall: "Курьер позвонит по этому номеру перед прибытием.",
    addrText: "Адрес доставки", addrPh: "Улица, дом, квартира, подъезд, этаж — напр.: Туран 37, кв. 12, подъезд 2, этаж 4",
    needLoc: "Укажите адрес доставки, чтобы курьер вас нашёл.",
    placedDelivery: "Курьер уже в пути. Позвоним перед прибытием.",
    openMap: "Открыть в 2ГИС", openMapG: "Google",
    tableNo: "Номер столика", yourName: "Ваше имя", phone: "Телефон",
    comment: "Комментарий (необязательно)", commentPh: "Аллергии, без сахара, погорячее…",
    placeOrder: "Отправить заказ", needTable: "Укажите номер столика (он на QR-подставке).",
    needContacts: "Укажите имя и телефон, чтобы мы позвонили, когда будет готово.",
    placed: "Заказ принят!", placedTable: "Уже готовим — принесём к столику",
    placedPickup: "Позвоним, когда заказ можно будет забрать.",
    orderNo: "Заказ", statusNow: "Текущий статус", refresh: "Обновить статус заказа",
    newOrder: "Новый заказ", aboutTitle: "Кафе о степи на городской лад",
    aboutText: "Yusup Cafe — ресторан твоей мечты в Шымкенте. Пицца, суши, бургеры, шашлык, кофе и десерты — всё в одном месте, всегда свежо, сытно и по-домашнему уютно, каждый день с 08:00 до 01:00.",
    addressT: "Адрес", hoursT: "Часы работы", phoneT: "Телефон",
    address: "ул. Юсуфа Сареми 964, ТЦ «Вахаб ата», Сайрам, Шымкент", hours: "Ежедневно · 08:00–01:00",
    staff: "Для персонала",
    activeOrder: "Ваш заказ", items: "поз.",
    footAbout: "Там, где дым от шашлыка и аромат чикена, всегда собираются самые искренние люди.",
    payBtn: "Оплатить", payTitle: "Оплата через Kaspi", payAmount: "Сумма заказа",
    kaspiScan: "Отсканируйте QR в приложении Kaspi", kaspiNoQr: "Здесь появится Kaspi QR кафе",
    kaspiStep1: "Откройте Kaspi → Платежи → Сканировать QR", kaspiStep2: "Переведите точную сумму заказа",
    kaspiStep3: "Затем нажмите «Я оплатил» ниже", iPaid: "Я оплатил", kaspiNote: "Оплата напрямую кафе через Kaspi",
    cancelPay: "Отмена", awaitingNote: "Ждём, пока кафе подтвердит вашу оплату в Kaspi. Готовка начнётся после подтверждения.",
    book: "Бронь столика", bookRoom: "Забронировать столик", rooms: "Столики", upTo: "До",
    people: "человек", pickRoom: "Выберите столик", whenVisit: "Когда придёте?",
    date: "Дата", time: "Время", guests: "Гостей", next: "Далее", chooseTime: "Выберите время",
    yourPhone: "Ваш телефон", phoneNote: "Мы позвоним, чтобы уточнить детали брони.",
    needPhone: "Введите корректный номер телефона.",
    preOrderTitle: "Желаете заказать еду заранее?",
    preOrderNote: "Такие блюда, как плов и куырдак, готовятся 2–3 часа. Закажите заранее, чтобы не ждать по приезде!",
    goToMenu: "Выбрать блюда", skipFood: "Пропустить и только забронировать столик",
    bookingFor: "Бронь", roomOnly: "Только столик — еда не заказана заранее",
    allTablesStopped: "Бронирование временно недоступно.",
    whenLabel: "Когда подать?", asap: "Как можно скорее", forTime: "Ко времени",
    schedPast: "Выберите время позже текущего.",
    schedFor: "Запланировано на", startCookApprox: "Начать готовить ~",
    schedSection: "Запланированные предзаказы", activeSection: "Активные сейчас",
    callConfirm: "Требуется подтверждение по телефону", callConfirmNote: "Позвоните клиенту, чтобы подтвердить бронь перед началом.",
    callDone: "Подтверждено по телефону",
    booked: "Занято", tooSmall: "Мало мест", checking: "проверяем…",
    busyAtTime: "Занято в это время", slotTaken: "Увы, это время только что заняли — выберите другое время.",
    bookingPay: "Чтобы подтвердить бронь, оплатите депозит / сумму предзаказа через Kaspi.",
    confirmBooking: "Подтвердить бронь",
    bookNoPay: "Забронировать (Оплата в кафе)",
    placeOrderFinal: "Отправить заказ (Оплата в кафе)",
    addrConfirmNote: "Пожалуйста, ещё раз проверьте адрес выше. Если что-то неверно — исправьте перед отправкой.",
    tlTitle: "Ход заказа", tlReceived: "Заказ принят", tlPreparing: "Готовится",
    tlReady: "Готов", tlDone: "Завершён", tlCancelled: "Отменён", minShort: "мин",
    beingPrepared: "Ваш заказ готовится", estRemaining: "Осталось примерно",
    prepReadyRestaurant: "Готовность в ресторане: примерно", prepReadyOrder: "Готовность заказа: примерно",
    deliveryTimeNote: "Время доставки не включено и зависит от курьера и дорожной ситуации.",
    almostReady: "Почти готово — уже совсем скоро", notifTitle: "Уведомления",
    ntfCooking: "Ваш заказ готовится. Примерное время: {m} минут.",
    ntfCookingNoTime: "Ваш заказ готовится.",
    ntfReady: "Ваш заказ готов.", ntfDone: "Заказ завершён. Спасибо!",
    ntfCancelled: "Ваш заказ отменён.",
    ntfCallConfirmed: "Ваша бронь подтверждена. Ждём вас!",
    bookingConfirmed: "Бронь подтверждена кафе",
    allOrders: "Заказы", boardTitle: "Найдите свой заказ",
    boardEmpty: "Активных заказов сейчас нет",
    boardHint: "Нажмите на номер своего заказа, чтобы увидеть детали.",
    backToList: "Все заказы",
    payKaspi: "Оплатить через Kaspi", openKaspi: "Открыть Kaspi",
    kaspiAmount: "Сумма к оплате",
    kaspiComment: "Укажите номер заказа в комментарии к переводу",
    orderFailed: "Не удалось отправить заказ. Попробуйте ещё раз.",
    ntfConfirmed: "Оплата подтверждена. Заказ передан на кухню.",
    cafeClosedAlert: "Кафе сейчас не работает, поэтому мы не можем принять заказ. Попробуйте, пожалуйста, в рабочее время.",
    takeawayUnavailable: "{items} нельзя заказать с доставкой или с собой.",
  },
  kz: {
    menu: "Мәзір", about: "Біз туралы", contacts: "Байланыс", cart: "Себет",
    tagline: "Шашлықтың түтіні мен чикеннің хош иісі бар жерде әрқашан ең шынайы адамдар жиналады.",
    heroText: "Пицца, суши, бургер, кофе және т.б. — үлкен мәзір, әрқашан жаңа әрі жайлы. Сайрам, Шымкент.",
    seeMenu: "Мәзірді ашу", today: "Бүгін ашық", until: "дейін",
    search: "Мәзірден іздеу…", all: "Барлығы", soldOut: "Аяқталды", add: "Қосу",
    cartEmpty: "Себет бос", cartEmptyHint: "Мәзірден бірдеңе қосыңыз — ол осында пайда болады.",
    total: "Жиыны", checkout: "Тапсырыс беру", back: "Артқа",
    subtotal: "Тағам құны", serviceFee: "Қызмет көрсету: 10%", totalToPay: "Төлеуге барлығы",
    privacyPolicy: "Құпиялылық саясатымен", consentPrefix: "Мен ", consentSuffix: " келісемін",
    consentNeed: "Жалғастыру үшін Құпиялылық саясатына келісіміңізді растаңыз.",
    orderType: "Қайда береміз?", atTable: "Үстеліме", pickup: "Өзіммен",
    delivery: "Жеткізу", atTableShort: "Үстелге",
    gpsOptional: "Мен қазір осындамын — GPS қосу (міндетті емес)", locating: "Анықтап жатырмыз…",
    gpsBtn: "Геолокациям", open2gis: "2ГИС ашу",
    mapPickBtn: "Картадан көрсету", mapPickTitle: "Курьер қайда келуі керек?",
    mapPickHint: "Нүкте үйіңіздің үстінде тұратындай картаны жылжытыңыз.",
    mapPickDone: "Осында жеткізу", mapPickLoading: "Мекенжайды анықтап жатырмыз…",
    deliveryFeeLbl: "Жеткізу", deliveryFree: "Тегін жеткізу",
    deliveryTooFar: "Өкінішке қарай, бұл нүкте жеткізу аймағынан тыс.",
    inclInTotal: "жалпы сомаға қосылды", needPin: "Картадан жеткізу нүктесін көрсетіңіз.",
    addrDetailsNote: "Пәтерді, кіреберісті және қабатты төмендегі пікірде көрсетіңіз.",
    gisHint: "2ГИС-тен орныңызды тауып, мекенжайды жоғарыда жазыңыз — немесе төменге 2ГИС сілтемесін қойыңыз.",
    gisLinkLabel: "2ГИС сілтемесі (міндетті емес)",
    gpsAttached: "Нақты геолокация тіркелді", courierCall: "Курьер келер алдында осы нөмірге қоңырау шалады.",
    addrText: "Жеткізу мекенжайы", addrPh: "Көше, үй, пәтер, кіреберіс, қабат — мыс.: Тұран 37, пәтер 12, кіреберіс 2, қабат 4",
    needLoc: "Курьер таба алуы үшін жеткізу мекенжайын жазыңыз.",
    placedDelivery: "Курьер жолда. Келер алдында қоңырау шаламыз.",
    openMap: "2ГИС-те ашу", openMapG: "Google",
    tableNo: "Үстел нөмірі", yourName: "Атыңыз", phone: "Телефон",
    comment: "Түсініктеме (міндетті емес)", commentPh: "Аллергия, қантсыз, ыстығырақ…",
    placeOrder: "Тапсырысты жіберу", needTable: "Үстел нөмірін көрсетіңіз (ол QR тұғырында).",
    needContacts: "Дайын болғанда қоңырау шалуымыз үшін атыңыз бен телефоныңызды көрсетіңіз.",
    placed: "Тапсырыс қабылданды!", placedTable: "Дайындап жатырмыз — үстелге әкелеміз",
    placedPickup: "Алуға дайын болғанда қоңырау шаламыз.",
    orderNo: "Тапсырыс", statusNow: "Ағымдағы күй", refresh: "Тапсырыс күйін жаңарту",
    newOrder: "Жаңа тапсырыс", aboutTitle: "Дала туралы қалалық кафе",
    aboutText: "Yusup Cafe — Шымкенттегі арманыңыздағы мейрамхана. Пицца, суши, бургер, шашлық, кофе және десерттер — барлығы бір жерде, әрқашан жаңа, тойымды әрі үйдегідей жайлы, күн сайын 08:00-ден 01:00-ге дейін.",
    addressT: "Мекенжай", hoursT: "Жұмыс уақыты", phoneT: "Телефон",
    address: "Юсуф Сареми к-сі 964, «Вахаб ата» СТ, Сайрам, Шымкент", hours: "Күн сайын · 08:00–01:00",
    staff: "Қызметкерлерге",
    activeOrder: "Сіздің тапсырысыңыз", items: "поз.",
    footAbout: "Шашлықтың түтіні мен чикеннің хош иісі бар жерде әрқашан ең шынайы адамдар жиналады.",
    payBtn: "Төлеу", payTitle: "Kaspi арқылы төлем", payAmount: "Тапсырыс сомасы",
    kaspiScan: "Kaspi қолданбасында осы QR-ды сканерлеңіз", kaspiNoQr: "Мұнда кафенің Kaspi QR-ы шығады",
    kaspiStep1: "Kaspi → Төлемдер → QR сканерлеу", kaspiStep2: "Тапсырыстың нақты сомасын аударыңыз",
    kaspiStep3: "Содан кейін төменнен «Төледім» басыңыз", iPaid: "Төледім", kaspiNote: "Kaspi арқылы тікелей кафеге төлем",
    cancelPay: "Болдырмау", awaitingNote: "Кафе Kaspi төлеміңізді растағанша күтудеміз. Растағаннан кейін дайындау басталады.",
    book: "Столик брондау", bookRoom: "Столик брондау", rooms: "Столиктер", upTo: "Дейін",
    people: "адам", pickRoom: "Столик таңдаңыз", whenVisit: "Қашан келесіз?",
    date: "Күні", time: "Уақыты", guests: "Қонақтар", next: "Әрі қарай", chooseTime: "Уақытты таңдаңыз",
    yourPhone: "Телефоныңыз", phoneNote: "Бронь мәліметтерін нақтылау үшін қоңырау шаламыз.",
    needPhone: "Дұрыс телефон нөмірін енгізіңіз.",
    preOrderTitle: "Тағамды алдын ала тапсырасыз ба?",
    preOrderNote: "Палау мен қуырдақ сияқты тағамдар 2–3 сағат дайындалады. Келгенде күтпеу үшін алдын ала тапсырыс беріңіз!",
    goToMenu: "Тағам таңдау", skipFood: "Тек столик брондау",
    bookingFor: "Бронь", roomOnly: "Тек столик — тағам алдын ала тапсырылмаған",
    allTablesStopped: "Брондау уақытша қолжетімсіз.",
    whenLabel: "Қашан беру керек?", asap: "Мүмкіндігінше тезірек", forTime: "Белгілі уақытқа",
    schedPast: "Қазіргіден кеш уақытты таңдаңыз.",
    schedFor: "Жоспарланған", startCookApprox: "Дайындауды бастау ~",
    schedSection: "Жоспарланған алдын ала тапсырыстар", activeSection: "Қазір белсенді",
    callConfirm: "Телефон арқылы растау қажет", callConfirmNote: "Бастамас бұрын брондауды растау үшін клиентке қоңырау шалыңыз.",
    callDone: "Телефонмен расталды",
    booked: "Бос емес", tooSmall: "Орын аз", checking: "тексерудеміз…",
    busyAtTime: "Бұл уақытта бос емес", slotTaken: "Өкінішке қарай, бұл уақыт енді ғана алынды — басқа уақытты таңдаңыз.",
    bookingPay: "Бронды растау үшін Kaspi арқылы депозит / алдын ала тапсырыс сомасын төлеңіз.",
    confirmBooking: "Бронды растау",
    bookNoPay: "Брондау (Кафеде төлеу)",
    placeOrderFinal: "Тапсырысты жіберу (Кафеде төлеу)",
    addrConfirmNote: "Жоғарыдағы мекенжайды тағы тексеріңіз. Қате болса — жіберу алдында түзетіңіз.",
    tlTitle: "Тапсырыс барысы", tlReceived: "Тапсырыс қабылданды", tlPreparing: "Дайындалуда",
    tlReady: "Дайын", tlDone: "Аяқталды", tlCancelled: "Болдырылмады", minShort: "мин",
    beingPrepared: "Тапсырысыңыз дайындалуда", estRemaining: "Шамамен қалды",
    prepReadyRestaurant: "Мейрамханада дайын болуы: шамамен", prepReadyOrder: "Тапсырыстың дайын болуы: шамамен",
    deliveryTimeNote: "Жеткізу уақыты қосылмаған және курьер мен жол жағдайына байланысты.",
    almostReady: "Дайын болуға жақын", notifTitle: "Хабарламалар",
    ntfCooking: "Тапсырысыңыз дайындалуда. Шамамен уақыты: {m} минут.",
    ntfCookingNoTime: "Тапсырысыңыз дайындалуда.",
    ntfReady: "Тапсырысыңыз дайын.", ntfDone: "Тапсырыс аяқталды. Рақмет!",
    ntfCancelled: "Тапсырысыңыз болдырылмады.",
    ntfCallConfirmed: "Броныңыз расталды. Сізді күтеміз!",
    bookingConfirmed: "Бронь кафемен расталды",
    allOrders: "Тапсырыстар", boardTitle: "Тапсырысыңызды табыңыз",
    boardEmpty: "Қазір белсенді тапсырыстар жоқ",
    boardHint: "Мәліметтерді көру үшін тапсырыс нөміріңізді басыңыз.",
    backToList: "Барлық тапсырыстар",
    payKaspi: "Kaspi арқылы төлеу", openKaspi: "Kaspi ашу",
    kaspiAmount: "Төлем сомасы",
    kaspiComment: "Аударым түсініктемесінде тапсырыс нөмірін көрсетіңіз",
    orderFailed: "Тапсырысты жіберу мүмкін болмады. Қайталап көріңіз.",
    ntfConfirmed: "Төлем расталды. Тапсырыс ас үйге жіберілді.",
    cafeClosedAlert: "Кафе қазір жұмыс істемейді, сондықтан тапсырысты қабылдай алмаймыз. Жұмыс уақытында қайталап көріңіз.",
    takeawayUnavailable: "{items} жеткізуге немесе өзімен алып кетуге тапсырыс беруге болмайды.",
  },
};

// Backend base URL. Set VITE_API_URL at build time to point this deployment
// at its own backend; the fallback keeps local dev working out of the box.
// The fallback is Yusup Cafe's backend and never crosses into another cafe.
const API = import.meta.env.VITE_API_URL || "https://yusup-cafe.onrender.com";

const fmt = (n) => n.toLocaleString("ru-RU") + " ₸";
// Mandatory 10% service charge. The backend re-computes and enforces this on
// every order (place + edit); the frontend mirrors it only for live display.
const SERVICE_FEE_RATE = 0; // "Обслуживание 0%" per the Yusup Cafe menu board
const serviceFeeOf = (subtotal) => Math.round(subtotal * SERVICE_FEE_RATE);

// Delivery pricing: concentric zones around the restaurant. Staff may edit
// both radius and price or add more zones. The backend re-computes the fee
// on every order, so this mirror is display-only.
const MAX_DELIVERY_ZONES = 8;
const DELIVERY_DEFAULTS = {
  // Yusup Cafe — Сайрам (the physical restaurant), from the owner's 2GIS pin
  // https://2gis.ru/geo/69.825314,42.434279 (2GIS gives lng,lat). The ring
  // centre is code-controlled only (no admin UI sets it), so it always comes
  // from here and can never drift from a stale stored value.
  lat: 42.434279, lng: 69.825314,
  zones: [{ km: 2, fee: 0 }, { km: 4, fee: 300 }, { km: 6, fee: 500 }],
};
const deliveryCfgOf = (cafeInfo) => {
  const d = (cafeInfo && cafeInfo.delivery) || {};
  const candidate = Array.isArray(d.zones) && d.zones.length >= 1
    && d.zones.length <= MAX_DELIVERY_ZONES
    ? d.zones.map((z) => ({
        km: Number(z && z.km),
        fee: Number(z && z.fee),
      }))
    : [];
  const valid = candidate.length > 0
    && candidate.every((z) => Number.isFinite(z.km) && z.km > 0 && z.km <= 100
      && Number.isInteger(z.fee) && z.fee >= 0 && z.fee <= 100000)
    && candidate.every((z, i) => i === 0 || candidate[i - 1].km < z.km);
  const zones = valid ? candidate : DELIVERY_DEFAULTS.zones.map((z) => ({ ...z }));
  // Centre is always the code constant — staff edit radii, never the centre.
  return {
    lat: DELIVERY_DEFAULTS.lat,
    lng: DELIVERY_DEFAULTS.lng,
    zones,
  };
};
const deliveryZoneColor = (index, count) => {
  const ratio = count <= 1 ? 0 : index / (count - 1);
  const hue = Math.round(120 - ratio * 112);
  return `hsl(${hue} 58% 43%)`;
};
const distKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};
// Fee for a point, or null when it lies outside every zone (no delivery).
const deliveryFeeFor = (cfg, lat, lng) => {
  const d = distKm(cfg.lat, cfg.lng, lat, lng);
  const ring = [...cfg.zones].sort((a, b) => a.km - b.km).find((z) => d <= z.km);
  return ring ? ring.fee : null;
};
const timeOf = (ts) => new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dateOf = (ts) => new Date(ts).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
const EMPTY_SALES_HISTORY = Object.freeze({ weeks: [], months: [], years: [] });
const salesHistoryPeriodLabel = (item, period, lang) => {
  const start = new Date(Number(item && item.start));
  if (!Number.isFinite(start.getTime())) return (item && item.key) || "-";
  const locale = lang === "en" ? "en-GB" : "ru-RU";
  if (period === "years") return (item && item.key) || "-";
  if (period === "months") {
    return new Intl.DateTimeFormat(locale, {
      month: "long",
      year: "numeric",
      timeZone: "Asia/Almaty",
    }).format(start);
  }
  const end = new Date(Number(item.end) - 1);
  const format = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Almaty",
  });
  return `${format.format(start)} - ${format.format(end)}`;
};

// language cycle: Russian → Kazakh → English → Russian …
const LANGS = ["ru", "kz", "en"];
const nextLang = (l) => LANGS[(LANGS.indexOf(l) + 1) % LANGS.length] || "ru";
const langCode = (l) => ({ ru: "РУС", kz: "ҚАЗ", en: "ENG" }[l] || "РУС");
// pick a localized string from {en,ru,kz}; Kazakh falls back to Russian, then English
const pickL = (obj, lang) => (obj && (obj[lang] || obj.ru || obj.en)) || "";
// inline 3-language helper for one-off labels
const L3 = (lang, en, ru, kz) => (lang === "en" ? en : lang === "kz" ? (kz || ru) : ru);
// translate a T-table key without a component-scoped t() (used in OrderCard)
const tr = (lang, key) => (T[lang] && T[lang][key]) || T.ru[key] || key;

// Cart keys are either a plain item id, or "id::sizeIndex" for items that
// have a `sizes` array (e.g. Americano 0.3л vs 0.4л) — this resolves a key
// back to the menu item plus the price/label for the size actually chosen.
function resolveCartLine(menu, cartId) {
  const [baseId, sizeIdxRaw] = cartId.split("::");
  const item = menu.find((m) => m.id === baseId);
  if (!item) return null;
  if (item.sizes && sizeIdxRaw !== undefined) {
    const size = item.sizes[Number(sizeIdxRaw)];
    if (size) return { item, price: size.price, sizeLabel: size.label };
  }
  return { item, price: item.price, sizeLabel: null };
}

const SIZE_FRIENDLY_CATS = new Set(["cold", "hot"]);

function orderedCats(menu) {
  const seen = new Set();
  const ids = [];
  (menu || []).forEach((m) => {
    if (m.cat && !seen.has(m.cat)) {
      seen.add(m.cat);
      ids.push(m.cat);
    }
  });
  CATS.forEach((c) => { if (!seen.has(c.id)) ids.push(c.id); });
  return ids.map((id) => CATS.find((c) => c.id === id)).filter(Boolean);
}

function reorderCategory(menu, catId, dir) {
  const cats = orderedCats(menu).map((c) => c.id).filter((id) => menu.some((m) => m.cat === id));
  const i = cats.indexOf(catId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cats.length) return menu;
  const nextCats = [...cats];
  [nextCats[i], nextCats[j]] = [nextCats[j], nextCats[i]];
  const byCat = new Map();
  menu.forEach((m) => {
    if (!byCat.has(m.cat)) byCat.set(m.cat, []);
    byCat.get(m.cat).push(m);
  });
  const out = [];
  nextCats.forEach((id) => out.push(...(byCat.get(id) || [])));
  menu.forEach((m) => { if (!nextCats.includes(m.cat)) out.push(m); });
  return out;
}

function moveMenuItem(menu, itemId, dir) {
  const item = menu.find((m) => m.id === itemId);
  if (!item) return menu;
  const cats = orderedCats(menu).map((c) => c.id).filter((id) => menu.some((m) => m.cat === id));
  const byCat = new Map();
  menu.forEach((m) => {
    if (!byCat.has(m.cat)) byCat.set(m.cat, []);
    byCat.get(m.cat).push(m);
  });
  const group = [...(byCat.get(item.cat) || [])];
  const i = group.findIndex((m) => m.id === itemId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= group.length) return menu;
  [group[i], group[j]] = [group[j], group[i]];
  byCat.set(item.cat, group);
  const out = [];
  cats.forEach((id) => out.push(...(byCat.get(id) || [])));
  menu.forEach((m) => { if (!cats.includes(m.cat)) out.push(m); });
  return out;
}

function menuImageFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) {
      reject(new Error("bad-type"));
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      reject(new Error("too-large"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read-failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode-failed"));
      img.onload = () => {
        const max = 900;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const out = canvas.toDataURL("image/jpeg", 0.82);
        if (out.length > 1_500_000) reject(new Error("compressed-too-large"));
        else resolve(out);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function apiGetMenu() {
  try { const r = await fetch(`${API}/api/menu`); return r.ok ? await r.json() : null; }
  catch (e) { return null; }
}

async function apiSaveMenu(items) {
  try {
    const r = await fetch(`${API}/api/menu`, { method: "POST", headers: authHeaders(), body: JSON.stringify(items) });
    return r.ok ? true : (r.status === 401 ? "auth" : false);
  }
  catch (e) { return false; }
}
async function apiGetOrders() {
  // Send the owner token when we have one: the server returns full orders
  // (names, phones, addresses) only to a logged-in owner; everyone else
  // gets a sanitized list safe for the public order board.
  try { const r = await fetch(`${API}/api/orders`, { headers: authHeaders() }); return await r.json(); }
  catch (e) { return []; }
}
async function apiGetOrder(id) {
  // Full details of one specific order — used by the customer's own
  // tracking screen; the id is known only to the browser that placed it.
  try { const r = await fetch(`${API}/api/orders/${id}`); return r.ok ? await r.json() : null; }
  catch (e) { return null; }
}
// Machine-readable reason of the last failed order submission, so checkout
// can show a specific message without exposing backend details.
let LAST_ORDER_ERROR = null;
async function apiPlaceOrder(order) {
  // Must report real success: the Kaspi flow only opens the payment page
  // after the order is confirmed saved — never send money for a lost order.
  LAST_ORDER_ERROR = null;
  try {
    const r = await fetch(`${API}/api/orders`, {
      method: "POST",
      headers: loyaltyHeaders(undefined, order.loyaltyMode !== "none"),
      body: JSON.stringify(order),
    });
    if (!r.ok) { try { LAST_ORDER_ERROR = (await r.json()).error || null; } catch (e) {} }
    return r.ok ? await r.json() : null;
  }
  catch (e) { return null; }
}
function loyaltyDeviceId() {
  let id = localStorage.getItem(LOYALTY_DEVICE_KEY);
  if (!id) {
    id = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(LOYALTY_DEVICE_KEY, id);
  }
  return id;
}

function loyaltyHeaders(codeOverride, includeStored = true) {
  const code = codeOverride || (includeStored ? localStorage.getItem(LOYALTY_CODE_KEY) : null);
  const legacyToken = !code && includeStored ? localStorage.getItem(LEGACY_LOYALTY_TOKEN_KEY) : null;
  return {
    ...(code ? { "X-Loyalty-Code": code } : {}),
    ...(legacyToken ? { "X-Loyalty-Token": legacyToken } : {}),
    "X-Loyalty-Device": loyaltyDeviceId(),
    "Content-Type": "application/json",
  };
}

function saveLoyaltyCode(code) {
  if (!isValidLoyaltyCode(code)) return false;
  localStorage.setItem(LOYALTY_CODE_KEY, code);
  localStorage.removeItem(LEGACY_LOYALTY_TOKEN_KEY);
  return true;
}

const LOYALTY_RATE_LIMITED = Symbol("loyalty-rate-limited");

async function apiGetLoyalty(codeOverride) {
  const hasStoredCredential = localStorage.getItem(LOYALTY_CODE_KEY)
    || localStorage.getItem(LEGACY_LOYALTY_TOKEN_KEY);
  if (!codeOverride && !hasStoredCredential) return null;
  try {
    const r = await fetch(`${API}/api/loyalty/me`, {
      headers: loyaltyHeaders(codeOverride),
      cache: "no-store",
    });
    if (!r.ok) {
      if (r.status === 429) return LOYALTY_RATE_LIMITED;
      if (!codeOverride && r.status === 401) {
        localStorage.removeItem(LOYALTY_CODE_KEY);
        localStorage.removeItem(LEGACY_LOYALTY_TOKEN_KEY);
      }
      return null;
    }
    const result = await r.json();
    if (result.code) saveLoyaltyCode(result.code);
    return result;
  } catch { return null; }
}

async function apiRotateLoyalty() {
  try {
    const r = await fetch(`${API}/api/loyalty/rotate`, {
      method: "POST",
      headers: loyaltyHeaders(),
      body: "{}",
    });
    if (!r.ok) return null;
    const result = await r.json();
    if (!saveLoyaltyCode(result.code)) return null;
    return result;
  } catch { return null; }
}
async function apiGetAdminLoyalty() {
  try {
    const r = await fetch(`${API}/api/admin/loyalty`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
async function apiAdjustLoyalty(accountId, amount, note) {
  try {
    const r = await fetch(`${API}/api/admin/loyalty/${encodeURIComponent(accountId)}/adjust`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount, note }),
    });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
// Client-side mirror of the backend allowlist: only ever open Kaspi domains.
const safeKaspiUrl = (u) =>
  (typeof u === "string" && (u.startsWith("https://pay.kaspi.kz/") || u.startsWith("https://kaspi.kz/"))) ? u : "";
async function apiUpdateStatus(id, status, extra) {
  // Returns true on success, "auth" when the login token is expired/invalid,
  // false on any other failure — callers must NOT pretend a failed write worked.
  try {
    const r = await fetch(`${API}/api/orders/${id}`, { method: "PUT", headers: authHeaders(), body: JSON.stringify({ status, ...(extra || {}) }) });
    if (r.status === 401) return "auth";
    return r.ok;
  }
  catch (e) { return false; }
}
async function apiCheckAuth() {
  try { const r = await fetch(`${API}/api/auth/check`, { headers: authHeaders() }); return r.ok; }
  catch (e) { return false; }
}
async function apiAckCall(id) {
  try { const r = await fetch(`${API}/api/orders/${id}/ack-call`, { method: "POST", headers: authHeaders(), body: "{}" }); return r.ok; }
  catch (e) { return false; }
}
async function apiGetNotifications(orderId) {
  try { const r = await fetch(`${API}/api/orders/${orderId}/notifications`); return await r.json(); }
  catch (e) { return []; }
}
async function apiMarkNotificationsRead(orderId) {
  try { await fetch(`${API}/api/orders/${orderId}/notifications/read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); return true; }
  catch (e) { return false; }
}
async function apiConfirmPayment(id) {
  try { const r = await fetch(`${API}/api/orders/${id}/confirm-payment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); return await r.json(); }
  catch (e) { return null; }
}
async function apiGetLedger() {
  try { const r = await fetch(`${API}/api/ledger`, { headers: authHeaders() }); return r.ok ? await r.json() : null; }
  catch (e) { return null; }
}
async function apiGetSalesHistory() {
  try {
    const r = await fetch(`${API}/api/admin/sales-history`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data && ["weeks", "months", "years"].every((key) => Array.isArray(data[key]))
      ? data
      : null;
  } catch (e) { return null; }
}
async function apiGetAdminTables() {
  try {
    const r = await fetch(`${API}/api/admin/tables`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data && Array.isArray(data.tables) ? data : null;
  } catch (e) { return null; }
}
async function apiSetAdminTableOccupied(number, occupied) {
  try {
    const r = await fetch(`${API}/api/admin/tables/${number}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ occupied }),
    });
    if (r.status === 401) return "auth";
    return r.ok;
  } catch (e) { return false; }
}
async function apiSettleLedger(note) {
  try { const r = await fetch(`${API}/api/ledger/settle`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ note }) }); return r.ok ? await r.json() : null; }
  catch (e) { return null; }
}
// Per-room slot info for a date+time: { roomId: { available, sitUntil } }.
// Rooms absent from the map have no bookings that day — fully free.
async function apiCheckAvailability(date, time) {
  try { const r = await fetch(`${API}/api/bookings/availability?date=${encodeURIComponent(date)}&time=${encodeURIComponent(time)}`); const d = await r.json(); return d.rooms || {}; }
  catch (e) { return {}; }
}
async function apiSetBookingEnd(id, endTime) {
  try { const r = await fetch(`${API}/api/orders/${id}/booking-end`, { method: "PUT", headers: authHeaders(), body: JSON.stringify({ endTime }) }); return r.ok; }
  catch (e) { return false; }
}

async function apiLogin(username, password) {
  try {
    const r = await fetch(`${API}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    localStorage.setItem("aspan-token", data.token);
    return data.token;
  } catch (e) { return null; }
}

function authHeaders() {
  const t = localStorage.getItem("aspan-token");
  return t
    ? { "Authorization": `Bearer ${t}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}
async function apiGetCafeStatus() {
  try { const r = await fetch(`${API}/api/settings/cafe`); return r.ok ? await r.json() : null; }
  catch (e) { return null; }
}

async function apiUpdateCafeStatus(data) {
  try {
    const r = await fetch(`${API}/api/settings/cafe`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(data) });
    return r.ok ? true : (r.status === 401 ? "auth" : false);
  }
  catch (e) { return false; }
}

async function apiEditOrderItems(id, items, newTotal) {
  try { const r = await fetch(`${API}/api/orders/${id}/items`, { method: "PUT", headers: authHeaders(), body: JSON.stringify({ items, newTotal }) }); return await r.json(); }
  catch (e) { return null; }
}

/* ── small shared pieces ─────────────────────────────────────────────── */


// The Yusup Cafe seal. The supplied PNG is a square burgundy tile with the
// round seal inset and the حلال script below it, so it is cropped to a circle
// and zoomed past the padding — the same treatment the brand sheet uses.
// `h` drives the whole lockup: seal diameter, wordmark size and gap.
// `tone="light"` puts the wordmark in ivory for dark surfaces.
// `responsive` drops the wordmark to a bare seal on narrow screens — the
// header row has no room for it next to the language and cart buttons.
const Logo = ({ h = 40, className = "", style = {}, tone = "dark", wordmark = true, responsive = false }) => (
  <span className={className}
    style={{ display: "flex", width: "fit-content", alignItems: "center", gap: Math.round(h * 0.3), ...style }}>
    <span style={{
      height: h, width: h, flex: "0 0 auto", position: "relative", overflow: "hidden",
      borderRadius: "50%", background: P.brand,
      boxShadow: `0 0 0 1px ${tone === "light" ? "rgba(255,255,255,.3)" : "rgba(116,36,39,.22)"}`,
    }}>
      <img src="/yusup-logo.png" alt={wordmark ? "" : "Yusup Cafe"} draggable="false"
        style={{ position: "absolute", left: "50%", top: "50%", width: "168%", maxWidth: "none", transform: "translate(-50%,-50%)" }} />
    </span>
    {wordmark && (
      <span className={responsive ? "brand-wordmark" : ""} style={{ lineHeight: 1 }}>
        <span style={{
          display: "block", fontFamily: FONT_DISPLAY, fontWeight: 700,
          fontSize: Math.round(h * 0.6), letterSpacing: "-.01em",
          color: tone === "light" ? P.bone : P.tealD,
        }}>Yusup Cafe</span>
        {h >= 44 && (
          <span style={{
            display: "block", marginTop: Math.round(h * 0.1),
            fontSize: Math.max(8, Math.round(h * 0.19)), fontWeight: 800,
            letterSpacing: ".22em", textTransform: "uppercase",
            color: tone === "light" ? "rgba(250,245,236,.5)" : "#9B8C83",
          }}>Halal</span>
        )}
      </span>
    )}
  </span>
);

const HERO_IMAGE = "/hero-feast.webp";

// Height of the fixed "cafe is closed" banner. The banner and the sticky
// header are both pinned to the top of the viewport, so the header is pushed
// down by exactly this much whenever the banner is showing.
const CLOSED_BANNER_H = 46;

// Decorative laurel sprig for the hero — the same wreath that rings the fork
// and spoon in the seal, drawn in brass and used sparingly on the burgundy.
const LaurelSprig = ({ size = 60, rotate = 0, opacity = 0.55, color = P.saff, style = {} }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true"
    className="absolute pointer-events-none select-none"
    style={{ transform: `rotate(${rotate}deg)`, opacity, ...style }}>
    <path d="M12 58C24 48 34 33 40 12" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    <g fill={color}>
      <ellipse cx="20" cy="46" rx="7" ry="3.4" transform="rotate(-32 20 46)" />
      <ellipse cx="27" cy="37" rx="7" ry="3.4" transform="rotate(-40 27 37)" />
      <ellipse cx="32" cy="27" rx="6.4" ry="3.2" transform="rotate(-50 32 27)" />
      <ellipse cx="36" cy="18" rx="5.6" ry="2.8" transform="rotate(-58 36 18)" />
      <ellipse cx="27" cy="49" rx="6" ry="3" transform="rotate(24 27 49)" />
      <ellipse cx="33" cy="40" rx="5.6" ry="2.8" transform="rotate(16 33 40)" />
      <ellipse cx="37" cy="31" rx="5" ry="2.5" transform="rotate(8 37 31)" />
    </g>
  </svg>
);

const AnimatedLaurel = ({
  size,
  rotate,
  opacity,
  style,
  drift = "a",
  delay = 0.36,
  reducedMotion,
  ambientActive,
}) => (
  <motion.div
    aria-hidden="true"
    className="absolute pointer-events-none select-none"
    style={style}
    initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: drift === "a" ? -4 : 4, y: 5 }}
    animate={{ opacity: 1, x: 0, y: 0 }}
    transition={{ duration: reducedMotion ? 0.14 : 0.64, delay: reducedMotion ? 0 : delay, ease: MOTION.ease.enter }}
  >
    <span className={`yusup-laurel-drift-${drift} ${ambientActive ? "" : "yusup-ambient-paused"}`}>
      <LaurelSprig size={size} rotate={rotate} opacity={opacity} style={{ position: "static" }} />
    </span>
  </motion.div>
);

const Pill = ({ bg, fg, children }) => (
  <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: bg, color: fg }}>{children}</span>
);

const StatusPill = ({ s, lang }) => {
  const st = STATUS[s] || STATUS.new;
  const reducedMotion = useReducedMotion();
  return (
    <motion.span layout
      initial={{ opacity: 0.72 }}
      animate={{ opacity: 1, backgroundColor: st.bg, color: st.fg }}
      transition={{ duration: reducedMotion ? 0.01 : 0.28, ease: MOTION.ease.enter }}
      className="text-xs font-bold px-2 py-0.5 rounded-full">
      {st[lang]}
    </motion.span>
  );
};

// Price breakdown for a live cart / checkout. The service fee only applies
// to waiter-served orders (dine-in / booking) — withFee=false collapses the
// breakdown to a plain total for to-go and delivery.
const PriceBreakdown = ({ subtotal, t, withFee = true, deliveryFee = 0, bonusUsed = 0, lang = "ru" }) => {
  const fee = withFee ? serviceFeeOf(subtotal) : 0;
  const dFee = deliveryFee > 0 ? deliveryFee : 0;
  const bonus = Math.max(0, Number(bonusUsed) || 0);
  if (!fee && !dFee && !bonus) {
    return (
      <div className="flex justify-between font-extrabold" style={{ color: P.txt }}><span>{t("total")}</span><span>{fmt(subtotal)}</span></div>
    );
  }
  return (
    <div>
      <div className="flex justify-between py-0.5 text-sm" style={{ color: P.sub }}><span>{t("subtotal")}</span><span>{fmt(subtotal)}</span></div>
      {fee > 0 && <div className="flex justify-between py-0.5 text-sm" style={{ color: P.sub }}><span>{t("serviceFee")}</span><span>{fmt(fee)}</span></div>}
      {dFee > 0 && <div className="flex justify-between py-0.5 text-sm" style={{ color: P.sub }}><span>{t("deliveryFeeLbl")}</span><span>{fmt(dFee)}</span></div>}
      {bonus > 0 && <div className="flex justify-between py-0.5 text-sm font-bold" style={{ color: P.green }}><span>{L3(lang, "Bonuses", "Бонусы", "Бонустар")}</span><span>−{fmt(bonus)}</span></div>}
      <div className="flex justify-between pt-1.5 mt-1 font-extrabold" style={{ borderTop: `1px solid ${P.line}`, color: P.txt }}><span>{t("totalToPay")}</span><span>{fmt(Math.max(0, subtotal + fee + dFee - bonus))}</span></div>
    </div>
  );
};

// Price breakdown for a saved order. Shows the fee rows only when the order
// actually carries a fee (waiter-served); to-go/delivery and legacy orders
// show a plain total.
const OrderPriceBreakdown = ({ order, t, lang = "ru" }) => {
  const svcFee = typeof order.subtotal === "number" && typeof order.serviceFee === "number" && order.serviceFee > 0 ? order.serviceFee : 0;
  const dFee = typeof order.deliveryFee === "number" && order.deliveryFee > 0 ? order.deliveryFee : 0;
  const bonus = typeof order.bonusUsed === "number" && order.bonusUsed > 0 ? order.bonusUsed : 0;
  if (!svcFee && !dFee && !bonus) {
    return (
      <div className="flex justify-between font-extrabold" style={{ color: P.txt }}><span>{t("total")}</span><span>{fmt(order.total || 0)}</span></div>
    );
  }
  return (
    <div>
      <div className="flex justify-between py-0.5 text-sm" style={{ color: P.sub }}><span>{t("subtotal")}</span><span>{fmt(order.subtotal || Math.max(0, (order.total || 0) - svcFee - dFee))}</span></div>
      {svcFee > 0 && <div className="flex justify-between py-0.5 text-sm" style={{ color: P.sub }}><span>{t("serviceFee")}</span><span>{fmt(svcFee)}</span></div>}
      {dFee > 0 && <div className="flex justify-between py-0.5 text-sm" style={{ color: P.sub }}><span>{t("deliveryFeeLbl")}</span><span>{fmt(dFee)}</span></div>}
      {bonus > 0 && <div className="flex justify-between py-0.5 text-sm font-bold" style={{ color: P.green }}><span>{L3(lang, "Bonuses", "Бонусы", "Бонустар")}</span><span>−{fmt(bonus)}</span></div>}
      <div className="flex justify-between pt-1.5 mt-1 font-extrabold" style={{ borderTop: `1px solid ${P.line}`, color: P.txt }}><span>{t("totalToPay")}</span><span>{fmt(order.total || 0)}</span></div>
    </div>
  );
};

// Re-renders on an interval so countdowns tick down without any network calls.
function useNowTick(active, ms = 15000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

const prepMinutesLeft = (estimatedReadyAt, now) => Math.ceil((estimatedReadyAt - now) / 60000);

const QtyControl = ({ qty, onMinus, onPlus, dark, plusDim }) => (
  <div className="flex items-center gap-2">
    <motion.button whileTap={{ scale: 0.9 }} transition={{ duration: MOTION.duration.micro }}
      onClick={onMinus} aria-label="minus" className="w-8 h-8 rounded-full font-bold text-lg leading-none"
      style={{ background: dark ? "rgba(255,255,255,.12)" : P.bone, color: dark ? "#fff" : P.txt }}>−</motion.button>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={qty} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
        transition={{ duration: MOTION.duration.micro }} className="w-6 text-center font-extrabold">{qty}</motion.span>
    </AnimatePresence>
    <motion.button whileTap={{ scale: 0.9 }} transition={{ duration: MOTION.duration.micro }}
      onClick={onPlus} aria-label="plus" className="w-8 h-8 rounded-full font-bold text-lg leading-none"
      style={{ background: plusDim ? P.sub : P.teal, color: "#fff", cursor: plusDim ? "not-allowed" : "pointer" }}>+</motion.button>
  </div>
);

/* ── guest: dish card ────────────────────────────────────────────────── */

function DishCard({ item, lang, t, image, cart, setQty, isClosed, index = 0, onAddFlight, reducedMotion }) {
  const cat = CATS.find((c) => c.id === item.cat);
  const off = !item.available;
  const hasSizes = Array.isArray(item.sizes) && item.sizes.length > 0;
  const [sizeIdx, setSizeIdx] = useState(0);
  const cardRef = React.useRef(null);
  const activePrice = hasSizes ? item.sizes[sizeIdx].price : item.price;
  const cartId = hasSizes ? `${item.id}::${sizeIdx}` : item.id;
  const qty = cart[cartId] || 0;
  // Closed cafe blocks growing the cart, but not shrinking/removing it — a
  // stale cart from before closing time should still be editable downward.
  const onPlus = () => {
    if (isClosed) {
      alert(t("cafeClosedAlert"));
      return;
    }
    setQty(cartId, qty + 1);
    onAddFlight?.({ sourceElement: cardRef.current, image, emoji: item.emoji });
  };
  const onMinus = () => setQty(cartId, qty - 1);
  return (
    <motion.div
      layout="position"
      initial={reducedMotion ? { opacity: 0 } : menuItemVariants.hidden}
      animate={menuItemVariants.visible}
      exit={menuItemVariants.exit}
      transition={{
        duration: reducedMotion ? 0.01 : 0.32,
        delay: reducedMotion ? 0 : Math.min(index, 5) * 0.035,
        ease: MOTION.ease.enter,
        layout: { duration: reducedMotion ? 0.01 : 0.34, ease: MOTION.ease.enter },
      }}
    >
      <motion.article
        ref={cardRef}
        className="rounded-2xl overflow-hidden flex flex-col h-full yusup-motion-surface"
        style={{ background: P.card, border: `1px solid ${P.line}`, opacity: off ? 0.55 : 1 }}
        initial="rest"
        animate="rest"
        whileHover={reducedMotion ? undefined : "hover"}
        whileTap={reducedMotion ? undefined : "pressed"}
        variants={{
          rest: { y: 0, scale: 1, boxShadow: "0 0 0 rgba(116,36,39,0)" },
          hover: { y: -4, boxShadow: "0 14px 30px rgba(116,36,39,.16)" },
          pressed: { scale: 0.985 },
        }}
        transition={{ duration: MOTION.duration.micro, ease: MOTION.ease.enter }}
      >
        <div className="relative flex items-center justify-center" style={{ background: cat?.tint || P.bone, height: 270, overflow: "hidden" }}>
          {image ? (
            <motion.img data-dish-visual src={image} alt={pickL(item.name, lang)}
              variants={{ rest: { scale: 1 }, hover: { scale: 1.035 }, pressed: { scale: 1.015 } }}
              transition={{ duration: 0.28, ease: MOTION.ease.enter }}
              style={{ width: "100%", height: "100%", objectFit: "cover", filter: off ? "grayscale(1)" : "none" }} />
          ) : (
            <motion.span data-dish-visual
              variants={{ rest: { scale: 1 }, hover: { scale: 1.035 }, pressed: { scale: 0.98 } }}
              style={{ fontSize: 52, filter: off ? "grayscale(1)" : "none" }} aria-hidden="true">{item.emoji}</motion.span>
          )}
          <div className="absolute top-2 left-2 flex gap-1 flex-wrap">
            {(item.tags || []).map((tg) => TAGS[tg] && <Pill key={tg} bg={TAGS[tg].bg} fg={TAGS[tg].fg}>{TAGS[tg][lang]}</Pill>)}
          </div>
          {off && <div className="absolute bottom-2 right-2"><Pill bg="#2b2b2b" fg="#fff">{t("soldOut")}</Pill></div>}
        </div>
        <div className="p-3 flex flex-col flex-1">
          <div className="font-extrabold leading-snug" style={{ color: P.txt }}>{pickL(item.name, lang)}</div>
          <div className="text-xs mt-1 flex-1" style={{ color: P.sub }}>{pickL(item.desc, lang)}</div>
          {hasSizes && (
            <div className="flex gap-1.5 mt-2">
              {item.sizes.map((s, i) => (
                <motion.button key={s.label} type="button" onClick={() => setSizeIdx(i)} whileTap={{ scale: 0.96 }}
                  className="text-xs font-bold px-2.5 py-1 rounded-full"
                  animate={{ backgroundColor: sizeIdx === i ? P.ink : P.bone, color: sizeIdx === i ? "#fff" : P.txt, borderColor: sizeIdx === i ? P.ink : P.line }}
                  transition={{ duration: MOTION.duration.micro }}
                  style={{ border: "1px solid" }}>
                  {s.label}
                </motion.button>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between mt-3">
            <div className="font-extrabold" style={{ color: P.txt }}>{item.priceMax ? `${activePrice.toLocaleString("ru-RU")} – ${fmt(item.priceMax)}` : fmt(activePrice)}</div>
            {off ? (
              <span className="text-xs font-bold" style={{ color: P.sub }}>—</span>
            ) : qty > 0 ? (
              <QtyControl qty={qty} onMinus={onMinus} onPlus={onPlus} plusDim={isClosed} />
            ) : (
              <motion.button onClick={onPlus} whileTap={{ scale: 0.94 }} className="text-sm font-bold px-3 py-1.5 rounded-full"
                transition={{ duration: MOTION.duration.micro }}
                style={{ background: isClosed ? P.sub : P.ink, color: "#fff", cursor: isClosed ? "not-allowed" : "pointer" }}>{t("add")} +</motion.button>
            )}
          </div>
        </div>
      </motion.article>
    </motion.div>
  );
}

/* ── delivery: geocoding + map link helpers (free, no API key) ───────── */

// Reverse geocoding (coordinates → readable address) via OpenStreetMap Nominatim.
// Best-effort: used only to pre-fill the address when GPS succeeds on a phone.
async function reverseGeocode(lat, lng, lang) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=${lang}`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const d = await r.json();
    return d && d.display_name ? d.display_name : "";
  } catch (e) { return ""; }
}

// Deep links so the courier/admin can open the exact point in their map app.
function mapLinks(lat, lng) {
  return {
    gis: `https://2gis.kz/geo/${lng},${lat}`,
    google: `https://maps.google.com/?q=${lat},${lng}`,
  };
}

/* ── guest: map pin picker ───────────────────────────────────────────── */

// Permission-free alternative to GPS: the client drags the map until the
// fixed centre pin sits on their building (the taxi-app pattern), so it
// works even where geolocation is blocked — in-app WebViews, denied
// permissions, disabled location services. Free OSM tiles, no API key.
function MapPicker({ open, onClose, onPick, lang, t, initial, deliveryCfg }) {
  const mapEl = React.useRef(null);
  const mapObj = React.useRef(null);
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState(true);
  // Fee for the current pin position: number (0/300/500…) or null = out of
  // every delivery zone (ordering blocked).
  const [fee, setFee] = useState(0);

  useEffect(() => {
    if (!open) return;
    const cfg = deliveryCfg || DELIVERY_DEFAULTS;
    const map = L.map(mapEl.current, { attributionControl: false, zoomControl: true });
    mapObj.current = map;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
    L.control.attribution({ prefix: false }).addAttribution("© OpenStreetMap").addTo(map);
    // Fee zones as concentric rings around the restaurant (largest first so
    // the inner ones stay clickable/visible), plus the restaurant itself.
    const sortedZones = [...cfg.zones].sort((a, b) => b.km - a.km);
    sortedZones.forEach((z, i) => {
      const color = deliveryZoneColor(sortedZones.length - i - 1, sortedZones.length);
      L.circle([cfg.lat, cfg.lng], {
        radius: z.km * 1000, color, weight: 1.5,
        fillColor: color, fillOpacity: 0.08, interactive: false,
      }).addTo(map);
    });
    L.circleMarker([cfg.lat, cfg.lng], {
      radius: 8, color: "#fff", weight: 2.5, fillColor: "#742427", fillOpacity: 1, interactive: false,
    }).addTo(map);
    map.setView(initial ? [initial.lat, initial.lng] : [cfg.lat, cfg.lng], initial ? 17 : 13);
    // The modal appears in the same frame the map mounts, so the container
    // is measured before it has its final size — remeasure once visible.
    setTimeout(() => map.invalidateSize(), 60);
    let tm = null;
    let dead = false;
    // Fee updates instantly while dragging (pure math, no network)…
    const updFee = () => {
      const c = map.getCenter();
      setFee(deliveryFeeFor(cfg, c.lat, c.lng));
    };
    // …the address lookup stays debounced on moveend (network call).
    const onMove = () => {
      setBusy(true);
      clearTimeout(tm);
      tm = setTimeout(async () => {
        const c = map.getCenter();
        const a = await reverseGeocode(c.lat, c.lng, lang);
        if (dead) return;
        setBusy(false);
        setAddr(a || `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`);
      }, 700);
    };
    map.on("move", updFee);
    map.on("moveend", onMove);
    updFee();
    onMove();
    return () => { dead = true; clearTimeout(tm); map.off("move", updFee); map.off("moveend", onMove); map.remove(); mapObj.current = null; };
  }, [open]);

  if (!open) return null;
  const confirm = () => {
    const c = mapObj.current ? mapObj.current.getCenter() : null;
    if (!c || fee === null) return;
    onPick({ lat: c.lat, lng: c.lng }, busy ? "" : addr, fee);
  };
  return (
    <div className="fixed inset-0 z-[80]" role="dialog" aria-label={t("mapPickTitle")}>
      <div className="absolute inset-0" style={{ background: "rgba(14,22,32,.55)" }} onClick={onClose} />
      <div className="absolute left-0 right-0 bottom-0 sm:left-1/2 sm:right-auto sm:bottom-auto sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[520px] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col" style={{ background: P.bone }}>
        <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${P.line}` }}>
          <div className="font-extrabold text-sm" style={{ fontFamily: FONT_DISPLAY, color: P.txt }}>{t("mapPickTitle")}</div>
          <button onClick={onClose} aria-label="close" className="w-8 h-8 rounded-full font-bold flex-shrink-0" style={{ background: P.card, border: `1px solid ${P.line}` }}>✕</button>
        </div>
        <div className="relative" style={{ height: "52vh", minHeight: 260 }}>
          <div ref={mapEl} className="absolute inset-0" style={{ zIndex: 0 }} />
          {/* Fixed pin over the map centre; its tip marks the delivery point. */}
          <div className="absolute left-1/2 top-1/2 pointer-events-none" style={{ transform: "translate(-50%, -100%)", zIndex: 500, filter: "drop-shadow(0 2px 4px rgba(0,0,0,.35))" }}>
            <svg width="30" height="40" viewBox="0 0 24 32" fill="none" aria-hidden="true">
              <path d="M12 0.8C5.9 0.8 1 5.7 1 11.8c0 8 11 19.4 11 19.4s11-11.4 11-19.4C23 5.7 18.1.8 12 .8Z" fill={P.brand} stroke="#fff" strokeWidth="1.5" />
              <circle cx="12" cy="11.6" r="4" fill="#fff" />
            </svg>
          </div>
        </div>
        <div className="px-4 py-3 flex flex-col gap-2" style={{ borderTop: `1px solid ${P.line}` }}>
          <div className="text-xs" style={{ color: P.sub }}>{t("mapPickHint")}</div>
          <div className="text-xs font-bold rounded-lg px-3 py-2" style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt, minHeight: 34 }}>
            {busy ? t("mapPickLoading") : addr}
          </div>
          <div className="text-xs font-extrabold rounded-lg px-3 py-2"
            style={fee === null
              ? { background: "#FAE5E3", color: "#933A34" }
              : fee === 0
                ? { background: "#E9F1DF", color: "#3F7A2E" }
                : { background: "#FBEFD9", color: "#8A5A12" }}>
            {fee === null ? <>{t("deliveryTooFar")}</>
              : fee === 0 ? <>{t("deliveryFree")}</>
              : <>{t("deliveryFeeLbl")}: +{fmt(fee)}</>}
          </div>
          <button type="button" onClick={confirm} disabled={fee === null}
            className="w-full py-3 rounded-xl font-extrabold text-sm"
            style={{ background: fee === null ? "#C9C2B6" : P.brand, color: "#fff", cursor: fee === null ? "not-allowed" : "pointer" }}>
            ✓ {t("mapPickDone")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── guest: order tracking (countdown, timeline, notifications) ──────── */

// Customer-facing countdown while the order is PREPARING.
function PrepCountdownCustomer({ live, t }) {
  if (live.type === "table") return null;
  const now = useNowTick(true, 15000);
  const left = prepMinutesLeft(live.estimated_ready_at, now);
  const label = live.type === "delivery" ? t("prepReadyRestaurant") : t("prepReadyOrder");
  return (
    <div className="mt-4 rounded-xl p-4 inline-flex flex-col items-center gap-1" style={{ background: "#FBEFD9", border: "1px solid #E8D9B5" }}>
      <div className="text-sm font-extrabold" style={{ color: "#8A5A12" }}>{t("beingPrepared")}</div>
      <div className="text-xs font-bold" style={{ color: "#8A5A12" }}>
        {left > 0 ? `${label} ${left} ${t("minShort")}` : t("almostReady")}
      </div>
      {live.type === "delivery" && (
        <div className="text-[11px] leading-snug text-center max-w-[260px]" style={{ color: "#8A5A12", opacity: 0.82 }}>
          {t("deliveryTimeNote")}
        </div>
      )}
    </div>
  );
}

// Order history: received → preparing → ready → completed (or cancelled).
function OrderTimeline({ o, t }) {
  const cancelled = o.status === "cancelled";
  const reachedPrep = !!o.preparation_started_at || ["cooking", "ready", "done"].includes(o.status);
  const reachedReady = !!o.ready_at || ["ready", "done"].includes(o.status);
  const reachedDone = !!o.completed_at || o.status === "done";
  const steps = [
    { label: t("tlReceived"), on: true, ts: o.ts },
    { label: t("tlPreparing"), on: reachedPrep, ts: o.preparation_started_at },
    { label: t("tlReady"), on: reachedReady, ts: o.ready_at },
    { label: t("tlDone"), on: reachedDone, ts: o.completed_at },
  ];
  if (cancelled) steps.push({ label: t("tlCancelled"), on: true, ts: o.cancelled_at, red: true });
  return (
    <div className="mt-5 mx-auto text-left rounded-xl p-4" style={{ background: P.card, border: `1px solid ${P.line}`, maxWidth: 292 }}>
      <div className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: P.sub }}>{t("tlTitle")}</div>
      {steps.map((s, i) => (
        <div key={i} className="flex items-center gap-3 py-1.5" style={{ opacity: s.on ? 1 : 0.42 }}>
          <span className="flex-shrink-0 inline-flex items-center justify-center rounded-full"
            style={{
              width: 22, height: 22,
              background: s.on ? (s.red ? "#FAE5E3" : P.ink) : P.bone,
              border: `1.5px solid ${s.on ? (s.red ? "#933A34" : P.ink) : P.line}`,
              color: s.on ? (s.red ? "#933A34" : "#fff") : "transparent",
              fontSize: 14, fontWeight: 900, lineHeight: 1,
            }}>
            {s.red ? "!" : "\u2713"}
          </span>
          <span className="text-[15px] font-extrabold leading-tight flex-1 text-center" style={{ color: s.red ? "#933A34" : P.txt }}>{s.label}</span>
          {s.on && s.ts ? <span className="text-xs pl-2 flex-shrink-0" style={{ color: P.sub, minWidth: 38, textAlign: "right" }}>{timeOf(s.ts)}</span> : <span style={{ minWidth: 38 }} />}
        </div>
      ))}
    </div>
  );
}

// Localizes a stored notification via its status; falls back to the raw message.
function ntfText(n, order, t) {
  if (n.status === "new") return t("ntfConfirmed"); // fires only on payment confirmation
  if (n.status === "cooking") {
    const m = order && order.preparation_minutes;
    return m ? t("ntfCooking").replace("{m}", m) : t("ntfCookingNoTime");
  }
  if (n.status === "ready") return t("ntfReady");
  if (n.status === "done") return t("ntfDone");
  if (n.status === "cancelled") return t("ntfCancelled");
  if (n.status === "call_confirmed") return t("ntfCallConfirmed");
  return n.message;
}

/* ── guest: privacy policy (Политика конфиденциальности) ─────────────── */
// Full text of the legal document, faithfully transcribed from the official
// PDF. Kept in Russian — it is a legal text of the Kazakhstani entity.
const PRIVACY_POLICY = {
  title: "Политика конфиденциальности",
  intro: "Настоящая Политика конфиденциальности определяет порядок сбора, использования и защиты персональных данных пользователей сайта Yusup Cafe (далее — «Сайт»).",
  sections: [
    { title: "1. Общие положения", body: [
      { p: "Используя Сайт, пользователь выражает согласие с настоящей Политикой конфиденциальности и условиями обработки своих персональных данных." },
      { p: "Обработка персональных данных осуществляется в соответствии с законодательством Республики Казахстан, включая Закон Республики Казахстан «О персональных данных и их защите»." },
    ]},
    { title: "2. Какие данные мы собираем", body: [
      { p: "Мы можем собирать следующую информацию:" },
      { ul: ["имя пользователя;", "номер телефона;", "адрес электронной почты;", "адрес доставки;", "данные для бронирования столика;", "данные, необходимые для оформления заказа;", "IP-адрес;", "сведения о браузере и устройстве;", "файлы Cookie;", "иные данные, добровольно предоставленные пользователем."] },
    ]},
    { title: "3. Цели обработки данных", body: [
      { p: "Персональные данные используются для:" },
      { ul: ["оформления и обработки заказов;", "организации доставки;", "бронирования столиков;", "обработки онлайн-платежей;", "обратной связи с пользователем;", "улучшения качества обслуживания;", "анализа посещаемости сайта;", "предоставления информации об услугах, акциях и специальных предложениях."] },
    ]},
    { title: "4. Онлайн-оплата", body: [
      { p: "Сайт может предоставлять возможность оплаты заказов онлайн через платежные сервисы, включая систему Kaspi и иные платежные сервисы." },
      { p: "При обработке платежей данные банковских карт и платежная информация обрабатываются непосредственно соответствующими платежными системами. Администрация сайта не хранит полные данные банковских карт пользователей." },
    ]},
    { title: "5. Доставка", body: [
      { p: "Для выполнения доставки заказов могут использоваться собственные службы доставки или сторонние партнеры." },
      { p: "Для выполнения заказа и доставки могут использоваться:" },
      { ul: ["имя пользователя;", "номер телефона;", "адрес доставки;", "сведения о заказе."] },
      { p: "Эти данные используются исключительно для исполнения заказа." },
    ]},
    { title: "6. Передача данных третьим лицам", body: [
      { p: "Персональные данные могут передаваться третьим лицам:" },
      { ul: ["платежным сервисам;", "службам доставки;", "поставщикам технических услуг;", "в случаях, предусмотренных законодательством Республики Казахстан."] },
    ]},
    { title: "7. Защита данных", body: [
      { p: "Администрация сайта принимает необходимые организационные и технические меры для защиты персональных данных от несанкционированного доступа, изменения, распространения или уничтожения." },
    ]},
    { title: "8. Использование файлов Cookie", body: [
      { p: "Сайт может использовать Cookie для:" },
      { ul: ["корректной работы сайта;", "сохранения пользовательских настроек;", "анализа посещаемости;", "улучшения пользовательского опыта."] },
      { p: "Пользователь может отключить Cookie в настройках браузера." },
    ]},
    { title: "9. Права пользователя", body: [
      { p: "Пользователь имеет право:" },
      { ul: ["получать информацию об обработке персональных данных;", "требовать изменения или удаления своих данных;", "отозвать согласие на обработку персональных данных;", "обращаться по вопросам обработки персональных данных."] },
    ]},
    { title: "10. Контактная информация", body: [
      { p: "Название ресторана: Yusup Cafe" },
      { p: "Телефон: +7 775 379 82 43" },
      { p: "Адрес: Сайрам, улица Юсуфа Сареми 964. ТЦ Вахаб ата" },
    ]},
    { title: "11. Изменения политики", body: [
      { p: "Администрация сайта оставляет за собой право изменять настоящую Политику конфиденциальности. Новая версия политики вступает в силу с момента публикации на сайте." },
    ]},
  ],
};

// Slide-over panel (same pattern as the cart/board drawers) so it reads well
// on mobile and is trivial to close. z-[80]: must layer above the cart drawer
// and booking wizard (z-50), because the consent link opens it from checkout.
function PrivacyPolicy({ open, onClose }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80]" role="dialog" aria-label={PRIVACY_POLICY.title}>
      <div className="absolute inset-0" style={{ background: "rgba(14,22,32,.55)" }} onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full sm:w-[480px] flex flex-col" style={{ background: P.bone }}>
        <div className="flex items-center justify-between gap-3 px-5 py-4" style={{ borderBottom: `1px solid ${P.line}` }}>
          <div className="font-extrabold text-base" style={{ fontFamily: FONT_DISPLAY, color: P.txt }}>{PRIVACY_POLICY.title}</div>
          <button onClick={onClose} aria-label="close" className="w-9 h-9 rounded-full font-bold flex-shrink-0" style={{ background: P.card, border: `1px solid ${P.line}` }}>✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="text-sm leading-relaxed" style={{ color: P.sub }}>{PRIVACY_POLICY.intro}</p>
          {PRIVACY_POLICY.sections.map((s) => (
            <div key={s.title} className="mt-5">
              <h3 className="font-extrabold text-sm mb-2" style={{ fontFamily: FONT_DISPLAY, color: P.txt }}>{s.title}</h3>
              {s.body.map((b, i) => b.p ? (
                <p key={i} className="text-sm leading-relaxed mt-1.5" style={{ color: P.sub }}>{b.p}</p>
              ) : (
                <ul key={i} className="mt-1.5 pl-5 flex flex-col gap-1" style={{ listStyle: "disc" }}>
                  {b.ul.map((li) => <li key={li} className="text-sm leading-relaxed" style={{ color: P.sub }}>{li}</li>)}
                </ul>
              ))}
            </div>
          ))}
          <div className="mt-6 mb-2 rounded-xl px-4 py-3 text-xs" style={{ background: P.card, border: `1px solid ${P.line}`, color: P.sub }}>
            Yusup Cafe · +7 775 379 82 43 · Сайрам, ул. Юсуфа Сареми 964, ТЦ «Вахаб ата»
          </div>
        </div>
        <div className="px-5 py-4" style={{ borderTop: `1px solid ${P.line}`, background: P.card }}>
          <button onClick={onClose} className="w-full py-3 rounded-xl font-extrabold" style={{ background: P.ink, color: "#fff" }}>
            ✕ Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── guest: public order board (find your order without an account) ──── */
// Shows only order number, status, items and timing — no customer names,
// phones or addresses are ever rendered here.
function OrdersBoard({ open, onClose, orders, lang, t, refreshOrders }) {
  // Orders are matched by their public number: the sanitized guest list
  // deliberately carries no internal ids.
  const [selNum, setSelNum] = useState(null);
  useEffect(() => {
    if (!open) return;
    setSelNum(null);
    refreshOrders();
    const tm = setInterval(refreshOrders, 20000); // stays under the API rate limit
    return () => clearInterval(tm);
  }, [open, refreshOrders]);
  if (!open) return null;

  const active = orders
    .filter((o) => ["new", "cooking", "ready"].includes(o.status))
    .sort((a, b) => (a.num || 0) - (b.num || 0));
  const sel = selNum ? orders.find((o) => o.num === selNum) : null;
  // Spec colors: preparing → neutral grey, ready → green, new → plain card.
  const colorOf = (s) => s === "ready"
    ? { bg: "#E9F1DF", fg: "#3F7A2E", bd: "#BFD8A8" }
    : s === "cooking"
      ? { bg: "#EFECE6", fg: "#776960", bd: P.line }
      : { bg: P.card, fg: P.txt, bd: P.line };

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label={t("boardTitle")}>
      <div className="absolute inset-0" style={{ background: "rgba(14,22,32,.55)" }} onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full sm:w-[420px] flex flex-col" style={{ background: P.bone }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${P.line}` }}>
          <div className="font-extrabold text-lg" style={{ fontFamily: FONT_DISPLAY, color: P.txt }}>
            {sel ? `${t("orderNo")} №${sel.num}` : t("boardTitle")}
          </div>
          <button onClick={onClose} aria-label="close" className="w-9 h-9 rounded-full font-bold" style={{ background: P.card, border: `1px solid ${P.line}` }}>✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!sel ? (
            active.length === 0 ? (
              <div className="text-center mt-16">
                <div className="font-extrabold mt-2" style={{ color: P.txt }}>{t("boardEmpty")}</div>
              </div>
            ) : (
              <>
                <div className="text-sm mb-3" style={{ color: P.sub }}>{t("boardHint")}</div>
                <div className="grid grid-cols-3 gap-2">
                  {active.map((o) => {
                    const c = colorOf(o.status);
                    return (
                      <button key={o.num} onClick={() => setSelNum(o.num)}
                        className="rounded-xl py-3 font-extrabold flex flex-col items-center gap-1"
                        style={{ background: c.bg, color: c.fg, border: `1px solid ${c.bd}` }}>
                        <span style={{ fontFamily: FONT_DISPLAY }}>№{o.num}</span>
                        <span className="text-xs font-bold" style={{ opacity: 0.8 }}>{(STATUS[o.status] || STATUS.new)[lang]}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex gap-4 mt-4 text-xs font-bold" style={{ color: P.sub }}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="rounded-full inline-block" style={{ background: "#EEEDEA", border: `1px solid ${P.line}`, width: 12, height: 12 }} /> {STATUS.cooking[lang]}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="rounded-full inline-block" style={{ background: "#E9F1DF", border: "1px solid #BFD8A8", width: 12, height: 12 }} /> {STATUS.ready[lang]}
                  </span>
                </div>
              </>
            )
          ) : (
            <div>
              <button onClick={() => setSelNum(null)} className="text-xs font-bold px-3 py-1.5 rounded-full mb-4" style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}>
                ← {t("backToList")}
              </button>
              <div className="flex items-center justify-between mb-1">
                <StatusPill s={sel.status} lang={lang} />
                <span className="text-xs" style={{ color: P.sub }}>{dateOf(sel.ts)} · {timeOf(sel.ts)}</span>
              </div>
              {sel.status === "cooking" && sel.estimated_ready_at ? (
                <div className="text-center"><PrepCountdownCustomer live={sel} t={t} /></div>
              ) : null}
              {sel.items && sel.items.length > 0 && (
                <div className="mt-4 rounded-xl p-3 text-sm" style={{ background: P.card, border: `1px solid ${P.line}` }}>
                  {sel.items.map((it, i) => (
                    <div key={i} className="flex justify-between py-0.5">
                      <span style={{ color: P.sub }}>{pickL(it.name, lang)} × {it.qty}</span>
                      <span className="font-bold" style={{ color: P.txt }}>{fmt(it.price * it.qty)}</span>
                    </div>
                  ))}
                  {typeof sel.total === "number" && (
                    <div className="pt-2 mt-1" style={{ borderTop: `1px solid ${P.line}` }}>
                      <OrderPriceBreakdown order={sel} t={t} lang={lang} />
                    </div>
                  )}
                </div>
              )}
              <div className="text-center"><OrderTimeline o={sel} t={t} /></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── guest: cart drawer (cart → checkout → confirmation) ─────────────── */

function LoyaltyDrawer({
  open, onClose, loyalty, loyaltyCode, loading, refresh, connectLoyalty,
  forgetLoyalty, rotateLoyalty, lang,
}) {
  const [codeInput, setCodeInput] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const eventLabel = (kind) => ({
    earn: L3(lang, "Order reward", "Начисление за заказ", "Тапсырыс бонусы"),
    redeem: L3(lang, "Used for an order", "Использовано в заказе", "Тапсырысқа жұмсалды"),
    restore: L3(lang, "Returned after cancellation", "Возврат после отмены", "Бас тартудан кейін қайтарылды"),
    adjustment: L3(lang, "Cafe adjustment", "Корректировка кафе", "Кафе түзетуі"),
  }[kind] || kind);
  const copyCode = async () => {
    if (!loyaltyCode) return;
    try {
      await navigator.clipboard.writeText(loyaltyCode);
      setMessage(L3(lang, "Bonus ID copied.", "Бонусный ID скопирован.", "Бонус ID көшірілді."));
    } catch {
      window.prompt(L3(lang, "Copy your bonus ID", "Скопируйте бонусный ID", "Бонус ID көшіріңіз"), loyaltyCode);
    }
  };
  const downloadCode = () => {
    if (!loyaltyCode) return;
    const content = L3(
      lang,
      `Yusup Cafe bonus ID: ${loyaltyCode}\nKeep this code private. Anyone with it can use your bonuses.`,
      `Бонусный ID Yusup Cafe: ${loyaltyCode}\nХраните код в секрете. Любой, кто его знает, сможет использовать бонусы.`,
      `Yusup Cafe бонус ID: ${loyaltyCode}\nКодты құпия сақтаңыз. Оны білетін адам бонустарды пайдалана алады.`,
    );
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "yusup-cafe-bonus-id.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const connect = async () => {
    if (!isValidLoyaltyCode(codeInput) || working) return;
    setWorking(true);
    setMessage("");
    const result = await connectLoyalty(codeInput);
    setWorking(false);
    if (result === LOYALTY_RATE_LIMITED) setMessage(L3(lang,
      "Too many attempts. Please try again in about 15 minutes.",
      "Слишком много попыток. Попробуйте примерно через 15 минут.",
      "Тым көп әрекет жасалды. Шамамен 15 минуттан кейін қайталаңыз."));
    else if (result) setCodeInput("");
    else setMessage(L3(lang, "Invalid bonus ID.", "Неверный бонусный ID.", "Бонус ID жарамсыз."));
  };
  const replaceCode = async () => {
    if (!window.confirm(L3(
      lang,
      "Replace this bonus ID? The old ID will stop working immediately.",
      "Заменить бонусный ID? Старый ID сразу перестанет работать.",
      "Бонус ID ауыстырылсын ба? Ескі ID бірден жұмысын тоқтатады.",
    ))) return;
    setWorking(true);
    const result = await rotateLoyalty();
    setWorking(false);
    setMessage(result
      ? L3(lang, "New bonus ID created. Save it now.", "Новый бонусный ID создан. Сохраните его.", "Жаңа бонус ID жасалды. Оны сақтаңыз.")
      : L3(lang, "Could not replace the bonus ID.", "Не удалось заменить бонусный ID.", "Бонус ID ауыстырылмады."));
  };
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true"
          aria-label={L3(lang, "Bonuses", "Бонусы", "Бонустар")}
          initial="closed" animate="open" exit="closed">
          <motion.div className="absolute inset-0" onClick={onClose}
            variants={{ closed: { opacity: 0 }, open: { opacity: 1 } }}
            style={{ background: "rgba(14,22,32,.55)" }} />
          <motion.aside className="absolute right-0 top-0 h-full w-full sm:w-[420px] flex flex-col"
            variants={{ closed: { x: "100%" }, open: { x: 0 } }}
            transition={{ duration: 0.28, ease: MOTION.ease.enter }}
            style={{ background: P.bone }}>
            <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${P.line}` }}>
              <div className="font-extrabold text-xl" style={{ fontFamily: FONT_DISPLAY, color: P.txt }}>
                {L3(lang, "Your bonuses", "Ваши бонусы", "Сіздің бонустарыңыз")}
              </div>
              <button type="button" onClick={onClose} aria-label="close" className="w-9 h-9 rounded-full font-bold"
                style={{ background: P.card, border: `1px solid ${P.line}` }}>×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-5">
              {loading ? (
                <div className="text-sm" style={{ color: P.sub }}>{L3(lang, "Loading...", "Загрузка...", "Жүктелуде...")}</div>
              ) : !loyalty ? (
                <div className="py-12 text-center">
                  <div className="mx-auto flex items-center justify-center rounded-full font-extrabold"
                    style={{ width: 64, height: 64, background: P.teal, color: "#fff", fontSize: 24 }}>B</div>
                  <div className="font-extrabold mt-5" style={{ color: P.txt }}>
                    {L3(lang, "Order on the website to start", "Закажите на сайте, чтобы начать", "Бастау үшін сайттан тапсырыс беріңіз")}
                  </div>
                  <div className="text-sm mt-2" style={{ color: P.sub }}>
                    {L3(lang, "You receive 3% after the cafe completes your order.", "После завершения заказа кафе начислит 3%.", "Кафе тапсырысты аяқтағаннан кейін 3% есептеледі.")}
                  </div>
                  <div className="mt-6 text-left rounded-xl p-4" style={{ background: P.card, border: `1px solid ${P.line}` }}>
                    <label className="text-xs font-extrabold" style={{ color: P.txt }}>
                      {L3(lang, "Already have a bonus ID?", "Уже есть бонусный ID?", "Бонус ID бар ма?")}
                    </label>
                    <input value={codeInput} maxLength={9} autoCapitalize="off" autoCorrect="off" spellCheck={false}
                      onChange={(event) => setCodeInput(normalizeLoyaltyCodeInput(event.target.value))}
                      placeholder="123456789" className="w-full mt-2 rounded-lg px-3 py-3 text-center font-extrabold tracking-widest outline-none"
                      style={{ background: P.bone, border: `1px solid ${P.line}`, color: P.txt }} />
                    <button type="button" onClick={connect} disabled={!isValidLoyaltyCode(codeInput) || working}
                      className="w-full mt-2 py-3 rounded-lg font-extrabold"
                      style={{ background: P.teal, color: "#fff", opacity: !isValidLoyaltyCode(codeInput) || working ? 0.5 : 1 }}>
                      {working ? "…" : L3(lang, "Connect ID", "Подключить ID", "ID қосу")}
                    </button>
                    {message && <div role="alert" className="text-xs font-bold mt-2" style={{ color: P.red }}>{message}</div>}
                  </div>
                </div>
              ) : (
                <>
                  <section className="py-5 px-5 rounded-lg" style={{ background: P.ink, color: "#fff" }}>
                    <div className="text-xs font-bold" style={{ color: "rgba(255,255,255,.65)" }}>{loyalty.maskedCode}</div>
                    <div className="mt-2 font-extrabold" style={{ fontFamily: FONT_DISPLAY, fontSize: 36 }}>{fmt(loyalty.balance || 0)}</div>
                    <div className="text-sm font-bold">{L3(lang, "Available", "Доступно", "Қолжетімді")}</div>
                    {(loyalty.pending || 0) > 0 && (
                      <div className="mt-3 text-sm font-bold" style={{ color: "#E7C995" }}>
                        +{fmt(loyalty.pending)} {L3(lang, "after order completion", "после завершения заказа", "тапсырыс аяқталғаннан кейін")}
                      </div>
                    )}
                  </section>
                  <section className="my-4 rounded-lg p-4" style={{ background: P.card, border: `1px solid ${P.line}` }}>
                    <div className="text-xs font-bold" style={{ color: P.sub }}>
                      {L3(lang, "Your private bonus ID", "Ваш секретный бонусный ID", "Құпия бонус ID")}
                    </div>
                    <div className="font-extrabold tracking-widest mt-1" style={{ color: P.txt, fontSize: 20 }}>
                      {loyaltyCode || loyalty.maskedCode}
                    </div>
                    <div className="text-xs mt-2" style={{ color: P.sub }}>
                      {L3(lang, "Anyone with this ID can spend the bonuses. Keep it private.", "Любой, кто знает ID, сможет списать бонусы. Храните его в секрете.", "Бұл ID-ны білетін адам бонустарды жұмсай алады. Құпия сақтаңыз.")}
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-3">
                      <button type="button" onClick={copyCode} disabled={!loyaltyCode}
                        className="py-2.5 rounded-lg text-xs font-extrabold" style={{ background: P.ink, color: "#fff", opacity: loyaltyCode ? 1 : 0.5 }}>
                        {L3(lang, "Copy", "Копировать", "Көшіру")}
                      </button>
                      <button type="button" onClick={downloadCode} disabled={!loyaltyCode}
                        className="py-2.5 rounded-lg text-xs font-extrabold" style={{ background: P.bone, border: `1px solid ${P.line}`, color: P.txt, opacity: loyaltyCode ? 1 : 0.5 }}>
                        {L3(lang, "Download", "Скачать", "Жүктеу")}
                      </button>
                    </div>
                    <div className="flex justify-between gap-3 mt-3">
                      <button type="button" onClick={replaceCode} disabled={working} className="text-xs font-bold underline" style={{ color: P.tealD }}>
                        {L3(lang, "Replace ID", "Заменить ID", "ID ауыстыру")}
                      </button>
                      <button type="button" onClick={forgetLoyalty} className="text-xs font-bold underline" style={{ color: P.red }}>
                        {L3(lang, "Forget on this device", "Забыть на устройстве", "Бұл құрылғыдан өшіру")}
                      </button>
                    </div>
                    {message && <div className="text-xs font-bold mt-3" style={{ color: P.tealD }}>{message}</div>}
                  </section>
                  <div className="grid grid-cols-3 gap-2 my-4 text-center">
                    {[
                      [`${loyalty.earnPercent || 3}%`, L3(lang, "earned", "начисляем", "есептеледі")],
                      [`${loyalty.redeemPercent || 20}%`, L3(lang, "max payment", "макс. оплаты", "макс. төлем")],
                      [`${loyalty.expiryDays || 90}`, L3(lang, "days", "дней", "күн")],
                    ].map(([value, label]) => (
                      <div key={label} className="py-3 px-1 rounded-lg" style={{ background: P.card, border: `1px solid ${P.line}` }}>
                        <div className="font-extrabold" style={{ color: P.txt }}>{value}</div>
                        <div className="text-[10px] font-bold mt-1" style={{ color: P.sub }}>{label}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between mt-6 mb-2">
                    <div className="font-extrabold" style={{ color: P.txt }}>{L3(lang, "History", "История", "Тарих")}</div>
                    <button type="button" onClick={refresh} className="w-8 h-8 rounded-full font-bold" title="Refresh"
                      style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}>↻</button>
                  </div>
                  <div>
                    {(loyalty.events || []).length === 0 && (
                      <div className="text-sm py-4" style={{ color: P.sub }}>{L3(lang, "No transactions yet.", "Операций пока нет.", "Әзірге операциялар жоқ.")}</div>
                    )}
                    {(loyalty.events || []).map((event, index) => (
                      <div key={`${event.kind}-${event.orderId || index}-${event.createdAt}`}
                        className="flex items-center gap-3 py-3" style={{ borderTop: `1px solid ${P.line}` }}>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-bold" style={{ color: P.txt }}>{eventLabel(event.kind)}</div>
                          <div className="text-xs mt-0.5" style={{ color: P.sub }}>
                            {new Date(event.createdAt).toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU")}
                          </div>
                        </div>
                        <div className="font-extrabold" style={{ color: event.amount >= 0 ? P.green : P.red }}>
                          {event.amount >= 0 ? "+" : "−"}{fmt(Math.abs(event.amount))}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CartDrawer({
  open, onClose, cart, menu, lang, t, setQty, placeOrder, lastOrder, orders,
  refreshOrders, resetAfterOrder, booking, clearBooking, kaspiUrl, isClosed,
  openPrivacy, cafeInfo, loyalty, refreshLoyalty, connectLoyalty,
  forgetLoyalty,
}) {
  const [step, setStep] = useState("cart");
  const [type, setType] = useState("table");
  const reducedMotion = useReducedMotion();
  const turnstileRef = React.useRef(null);
  const turnstileWidgetId = React.useRef(null);
  const [table, setTable] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [comment, setComment] = useState("");
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const [location, setLocation] = useState(null);
  const [address, setAddress] = useState("");
  const [mapOpen, setMapOpen] = useState(false);
  const pickFromMap = ({ lat, lng }, addr) => {
    setMapOpen(false);
    setLocation({ lat, lng });
    if (addr) setAddress(addr);
    else reverseGeocode(lat, lng, lang).then((a) => { if (a) setAddress(a); });
  };
  // Manual "Обновить" tap on the tracking screen: shows a spinner for a beat
  // so the click visibly registers even when the fetched status is unchanged
  // (previously it silently no-op'd from the customer's point of view).
  const [refreshingOrder, setRefreshingOrder] = useState(false);
  const doRefreshOrder = async () => {
    if (refreshingOrder) return;
    setRefreshingOrder(true);
    try { await refreshOrders(); } finally {
      setTimeout(() => setRefreshingOrder(false), 400);
    }
  };
  // Personal-data consent (required by the privacy policy before submitting
  // any order or booking — the submit button stays disabled until checked).
  const [consent, setConsent] = useState(false);
  const [consentError, setConsentError] = useState(false); // shown after a submit tap without consent
  const [consentShake, setConsentShake] = useState(false);  // one-shot shake animation
  // Delayed fulfillment: "asap" (default) or a chosen time today for
  // delivery / to-go orders (Part 4). schedH/schedM are the target time.
  const [schedMode, setSchedMode] = useState("asap");
  const [schedH, setSchedH] = useState("");
  const [schedM, setSchedM] = useState("");
  const [useBonus, setUseBonus] = useState(false);
  const [bonusToUse, setBonusToUse] = useState(0);
  const [loyaltyMode, setLoyaltyMode] = useState(() => loyalty ? "connected" : "enroll");
  const [loyaltyInput, setLoyaltyInput] = useState("");
  const [connectingLoyalty, setConnectingLoyalty] = useState(false);
  const [loyaltyMessage, setLoyaltyMessage] = useState("");
  const [newLoyaltyCode, setNewLoyaltyCode] = useState("");

  const clearCheckoutSecurity = useCallback(() => {
    setCaptchaToken("");
    if (window.turnstile && turnstileWidgetId.current !== null) {
      try { window.turnstile.remove(turnstileWidgetId.current); } catch (e) {}
    }
    turnstileWidgetId.current = null;
  }, []);

  const returnToCart = () => {
    clearCheckoutSecurity();
    setErr("");
    setConsentError(false);
    setConsentShake(false);
    setStep("cart");
  };

  const entries = Object.entries(cart).map(([cartId, q]) => {
    const r = resolveCartLine(menu, cartId);
    return r ? { cartId, item: r.item, price: r.price, sizeLabel: r.sizeLabel, q } : null;
  }).filter(Boolean);
  const takeawayBlockedItems = !booking && (type === "pickup" || type === "delivery")
    ? entries.filter(({ item }) => item.deliveryAvailable === false)
    : [];
  const takeawayBlockedNames = [...new Set(takeawayBlockedItems.map(({ item }) => pickL(item.name, lang)))];
  const takeawayBlockedMessage = t("takeawayUnavailable").replace("{items}", takeawayBlockedNames.join(", "));
  const subtotal = entries.reduce((s, e) => s + e.price * e.q, 0);
  // Service fee only for waiter-served orders: dine-in at a table or a table
  // booking. To-go and delivery have no waiter, so no fee.
  const feeApplies = booking ? true : type === "table";
  const serviceFee = feeApplies ? serviceFeeOf(subtotal) : 0;
  // Delivery fee from the zone the pin falls in; null = outside every zone
  // (submission blocked). Mirrors the authoritative server-side computation.
  const deliveryCfg = useMemo(() => deliveryCfgOf(cafeInfo), [cafeInfo]);
  const deliveryFee = (!booking && type === "delivery" && location)
    ? deliveryFeeFor(deliveryCfg, location.lat, location.lng)
    : 0;
  const activeLoyalty = !!loyalty && loyaltyMode !== "none";
  const bonusLimit = !booking
    ? bonusSpendLimit(
      subtotal, activeLoyalty ? loyalty?.balance || 0 : 0, loyalty?.redeemPercent || 20,
      loyalty?.maxRedemptionPerOrder || 50_000,
    )
    : 0;
  const bonusUsed = useBonus
    ? clampBonusUse(
      bonusToUse, subtotal, loyalty?.balance || 0, loyalty?.redeemPercent || 20,
      loyalty?.maxRedemptionPerOrder || 50_000,
    )
    : 0;
  const grossTotal = subtotal + serviceFee + (deliveryFee > 0 ? deliveryFee : 0);
  const grandTotal = Math.max(0, grossTotal - bonusUsed);
  const bonusPreview = bonusEarnPreview(subtotal, bonusUsed, loyalty?.earnPercent || 3);
  useEffect(() => {
    setBonusToUse((current) => clampBonusUse(
      current, subtotal, loyalty?.balance || 0, loyalty?.redeemPercent || 20,
      loyalty?.maxRedemptionPerOrder || 50_000,
    ));
    if (bonusLimit <= 0) setUseBonus(false);
  }, [subtotal, bonusLimit, loyalty?.balance, loyalty?.redeemPercent, loyalty?.maxRedemptionPerOrder]);
  const connectEnteredLoyalty = async () => {
    if (!isValidLoyaltyCode(loyaltyInput) || connectingLoyalty) return;
    setConnectingLoyalty(true);
    setLoyaltyMessage("");
    const result = await connectLoyalty(loyaltyInput);
    setConnectingLoyalty(false);
    if (result === LOYALTY_RATE_LIMITED) {
      setLoyaltyMessage(L3(lang,
        "Too many attempts. Please try again in about 15 minutes.",
        "Слишком много попыток. Попробуйте примерно через 15 минут.",
        "Тым көп әрекет жасалды. Шамамен 15 минуттан кейін қайталаңыз."));
    } else if (result) {
      setLoyaltyInput("");
      setLoyaltyMode("connected");
    } else {
      setLoyaltyMessage(L3(lang, "Invalid bonus ID.", "Неверный бонусный ID.", "Бонус ID жарамсыз."));
    }
  };
  const copyNewLoyaltyCode = async () => {
    if (!newLoyaltyCode) return;
    try { await navigator.clipboard.writeText(newLoyaltyCode); }
    catch { window.prompt(L3(lang, "Copy your bonus ID", "Скопируйте бонусный ID", "Бонус ID көшіріңіз"), newLoyaltyCode); }
  };
  const downloadNewLoyaltyCode = () => {
    if (!newLoyaltyCode) return;
    const text = `Yusup Cafe bonus ID: ${newLoyaltyCode}\nKeep this code private. Anyone with it can use your bonuses.`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "yusup-cafe-bonus-id.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  // The public orders list is sanitized (no address/table/booking and no
  // ids), so the tracked order's full details come from a direct by-id
  // fetch — only this browser knows the id it generated at checkout. The
  // list still provides live status (matched by order number) as fallback.
  const [ownOrder, setOwnOrder] = useState(null);
  useEffect(() => {
    if (!(open && lastOrder)) return;
    let stop = false;
    const load = async () => { const o = await apiGetOrder(lastOrder.id); if (!stop && o) setOwnOrder(o); };
    load();
    const tm = setInterval(load, 10000);
    return () => { stop = true; clearInterval(tm); };
  }, [open, lastOrder]);
  const live = lastOrder
    ? ((ownOrder && ownOrder.id === lastOrder.id)
      ? ownOrder
      : orders.find((o) => o.num === lastOrder.num) || lastOrder)
    : null;

  useEffect(() => {
  window.onTurnstileVerified = (token) => setCaptchaToken(token);
  }, []);
  // The Turnstile div only enters the DOM once the drawer reaches the
  // checkout step, but the Cloudflare script only auto-scans the page
  // once on initial load — so it never sees this element and no widget
  // (and no token) ever appears. Render it explicitly instead.
  useEffect(() => {
    if (!open || step !== "checkout") return;
    let cancelled = false;
    const tryRender = () => {
      if (cancelled) return;
      const el = turnstileRef.current;
      if (!el || !window.turnstile) {
        setTimeout(tryRender, 100);
        return;
      }
      if (turnstileWidgetId.current !== null) {
        try { window.turnstile.remove(turnstileWidgetId.current); } catch (e) {}
        turnstileWidgetId.current = null;
      }
      try {
        turnstileWidgetId.current = window.turnstile.render(el, {
          sitekey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
          theme: "light",
          callback: (token) => setCaptchaToken(token),
        });
      } catch (e) {
        setErr(lang === "en" ? "Security check could not load. Please reopen checkout." : "Проверка безопасности не загрузилась. Откройте оформление заново.");
      }
    };
    tryRender();
    return () => {
      cancelled = true;
      if (window.turnstile && turnstileWidgetId.current !== null) {
        try { window.turnstile.remove(turnstileWidgetId.current); } catch (e) {}
      }
      turnstileWidgetId.current = null;
    };
  }, [open, step, lang]);
  useEffect(() => { if (open && lastOrder && step === "done") { const tm = setInterval(refreshOrders, 10000); return () => clearInterval(tm); } }, [open, step, lastOrder, refreshOrders]);
  useEffect(() => {
    if (open && step !== "done") {
      if (booking) setStep("checkout");
      else if (entries.length) setStep(step);
      // No cart but a tracked order exists → reopen straight into tracking
      // (also for just-finished orders, so the final notification is seen).
      else if (live && ["awaiting_confirmation", "new", "cooking", "ready", "done", "cancelled"].includes(live.status)) setStep("done");
      else setStep("cart");
    }
  }, [open]);
  useEffect(() => {
    if (open && step === "checkout" && refreshLoyalty) refreshLoyalty();
  }, [open, step, refreshLoyalty]);

  // Status-change notifications for the tracked order (poll at 20s to stay
  // well under the API rate limit; countdowns tick locally without network).
  const [ntfs, setNtfs] = useState([]);
  const liveId = live ? live.id : null;
  useEffect(() => {
    if (!(open && step === "done" && liveId)) return;
    let stop = false;
    const load = async () => {
      const list = await apiGetNotifications(liveId);
      if (stop || !Array.isArray(list)) return;
      setNtfs(list);
      if (list.some((n) => !n.read_status)) apiMarkNotificationsRead(liveId);
    };
    load();
    const tm = setInterval(load, 20000);
    return () => { stop = true; clearInterval(tm); };
  }, [open, step, liveId]);

  // Every order — booking or regular — is placed as a normal order, paid at the cafe.
  // No payment gateway, no awaiting_confirmation step. Kitchen sees it immediately.
  const submitOrder = async () => {
    setErr("");
    if (isClosed) {
      alert(t("cafeClosedAlert"));
      return;
    }
    if (takeawayBlockedItems.length) {
      setErr(takeawayBlockedMessage);
      return;
    }
    // Consent is the visible required step, so it gates first — a tap without
    // it always draws attention to the box (inline red message + shake).
    if (!consent) {
      setConsentError(true);
      setConsentShake(true);
      setTimeout(() => setConsentShake(false), 600);
      return;
    }
    if (!captchaToken) {
      setErr(lang === "en" ? "Please complete the security check." : "Пройдите проверку безопасности.");
      return;
    }

    if (!booking) {
      if (type === "table" && !table.trim()) return setErr(t("needTable"));
      if (type === "table" && !phone.trim()) {
        return setErr(L3(lang, "Enter your phone to receive website bonuses.", "Введите телефон, чтобы получать бонусы сайта.", "Сайт бонустарын алу үшін телефонды енгізіңіз."));
      }
      if (type === "pickup" && (!name.trim() || !phone.trim())) return setErr(t("needContacts"));
      if (type === "delivery") {
        if (!name.trim() || !phone.trim()) return setErr(t("needContacts"));
        if (!location) return setErr(t("needPin"));
        if (deliveryFee === null) return setErr(t("deliveryTooFar"));
      }
      if (loyaltyMode === "existing" && !loyalty) {
        return setLoyaltyMessage(L3(
          lang,
          "Connect your bonus ID or choose another bonus option.",
          "Подключите бонусный ID или выберите другой вариант.",
          "Бонус ID қосыңыз немесе басқа нұсқаны таңдаңыз.",
        ));
      }
    }

    // Requested fulfillment time for scheduled delivery / to-go orders. Must
    // be later than now; otherwise it's treated as ASAP (no schedule).
    let scheduledFor = null;
    if (!booking && (type === "pickup" || type === "delivery") && schedMode === "time") {
      if (!schedH || !schedM) return setErr(t("schedPast"));
      const d = new Date();
      d.setHours(Number(schedH), Number(schedM), 0, 0);
      if (d.getTime() <= Date.now()) return setErr(t("schedPast"));
      scheduledFor = d.getTime();
    }

    setSending(true);
    const links = location ? mapLinks(location.lat, location.lng) : null;
    const viaKaspi = !booking && !!kaspiUrl;

    let placed;
    if (booking) {
      placed = await placeOrder({
        type: "booking",
        phone: booking.phone,
        comment: comment.trim(),
        booking: booking,
        items: entries.map((e) => ({
          id: e.item.id,
          name: e.sizeLabel ? { en: `${e.item.name.en} (${e.sizeLabel})`, ru: `${e.item.name.ru} (${e.sizeLabel})`, kz: `${e.item.name.kz} (${e.sizeLabel})` } : e.item.name,
          price: e.price, qty: e.q, sizeLabel: e.sizeLabel,
        })),
        subtotal, serviceFee, total: grandTotal,
        status: "new",
        paymentMethod: "at_table",
        loyaltyMode: activeLoyalty ? "existing" : "none",
        captcha: captchaToken,
      });
      if (placed && clearBooking) clearBooking();
    } else {
      placed = await placeOrder({
        type, table: table.trim(), name: name.trim(), phone: phone.trim(), comment: comment.trim(),
        address: address.trim(),
        lat: location ? location.lat : null,
        lng: location ? location.lng : null,
        mapLink: links ? links.gis : null,
        mapLinkGoogle: links ? links.google : null,
        items: entries.map((e) => ({
          id: e.item.id,
          name: e.sizeLabel ? { en: `${e.item.name.en} (${e.sizeLabel})`, ru: `${e.item.name.ru} (${e.sizeLabel})`, kz: `${e.item.name.kz} (${e.sizeLabel})` } : e.item.name,
          price: e.price, qty: e.q, sizeLabel: e.sizeLabel,
        })),
        subtotal, serviceFee,
        deliveryFee: type === "delivery" && deliveryFee > 0 ? deliveryFee : 0,
        total: grandTotal,
        bonusToUse: bonusUsed,
        loyaltyMode: activeLoyalty ? "existing" : loyaltyMode,
        scheduledFor,
        // Kaspi orders wait for staff to confirm the money (the server
        // enforces this status regardless of what we send here).
        status: viaKaspi ? "awaiting_confirmation" : "new",
        paymentMethod: viaKaspi ? "kaspi" : "at_table",
        captcha: captchaToken,
      });
    }
    setSending(false);
    if (!placed) {
      // Do NOT advance and never open Kaspi for an unsaved order. The
      // captcha token is single-use — reset the widget for a clean retry.
      setErr(
        LAST_ORDER_ERROR === "slot_taken"
          ? t("slotTaken")
          : LAST_ORDER_ERROR === "invalid_loyalty_id"
            ? L3(lang, "Invalid bonus ID.", "Неверный бонусный ID.", "Бонус ID жарамсыз.")
            : LAST_ORDER_ERROR === "loyalty_rate_limited"
              ? L3(lang, "Too many incorrect bonus IDs. Try again in 15 minutes.", "Слишком много неверных ID. Повторите через 15 минут.", "Қате ID тым көп. 15 минуттан кейін қайталаңыз.")
            : t("orderFailed")
      );
      setCaptchaToken("");
      if (window.turnstile && turnstileWidgetId.current !== null) {
        try { window.turnstile.reset(turnstileWidgetId.current); } catch (e) {}
      }
      return;
    }
    if (placed.issuedLoyaltyCode) setNewLoyaltyCode(placed.issuedLoyaltyCode);
    if (refreshLoyalty) refreshLoyalty();
    if (viaKaspi) window.open(kaspiUrl, "_blank", "noopener,noreferrer");
    setStep("done");
  };

  return (
    <AnimatePresence>
      {open && (
    <motion.div className="fixed inset-0 z-50" role="dialog" aria-label={t("cart")}
      initial="closed" animate="open" exit="closed">
      <motion.div className="absolute inset-0"
        variants={{ closed: { opacity: 0 }, open: { opacity: 1 } }}
        transition={{ duration: reducedMotion ? 0.12 : 0.22 }}
        style={{ background: "rgba(14,22,32,.55)" }} onClick={onClose} />
      <motion.div className="absolute right-0 top-0 h-full w-full sm:w-[420px] flex flex-col"
        variants={{
          closed: reducedMotion ? { opacity: 0 } : { x: "100%" },
          open: reducedMotion ? { opacity: 1 } : { x: 0 },
        }}
        transition={{ duration: reducedMotion ? 0.14 : MOTION.duration.component, ease: MOTION.ease.enter }}
        style={{ background: P.bone }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${P.line}` }}>
          <div className="font-extrabold text-lg" style={{ fontFamily: FONT_DISPLAY, color: P.txt }}>
            {step === "done" ? t("placed") : step === "checkout" ? t("checkout") : t("cart")}
          </div>
          <motion.button whileTap={{ scale: 0.9 }} onClick={onClose} aria-label="close" className="w-9 h-9 rounded-full font-bold"
            style={{ background: P.card, border: `1px solid ${P.line}` }}>✕</motion.button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={step}
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -8 }}
              transition={{ duration: reducedMotion ? 0.12 : 0.24, ease: MOTION.ease.enter }}>
          {step === "cart" && (entries.length === 0 ? (
            <div className="text-center mt-16">
              <div className="font-extrabold mt-2" style={{ color: P.txt }}>{t("cartEmpty")}</div>
              <div className="text-sm mt-1" style={{ color: P.sub }}>{t("cartEmptyHint")}</div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {entries.map(({ cartId, item, price, sizeLabel, q }) => (
                <div key={cartId} className="flex items-center gap-3 rounded-xl p-3" style={{ background: P.card, border: `1px solid ${P.line}` }}>
                  <div className="w-12 h-12 rounded-lg overflow-hidden flex items-center justify-center text-2xl flex-shrink-0" style={{ background: CATS.find((c) => c.id === item.cat)?.tint }}>
                    {(item.image || GALLERY_MENU_IMAGES[item.id])
                      ? <img src={item.image || GALLERY_MENU_IMAGES[item.id]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      : item.emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm truncate" style={{ color: P.txt }}>{pickL(item.name, lang)}{sizeLabel ? ` (${sizeLabel})` : ""}</div>
                    <div className="text-xs" style={{ color: P.sub }}>{fmt(price)}</div>
                  </div>
                  <QtyControl qty={q} onMinus={() => setQty(cartId, q - 1)} onPlus={() => setQty(cartId, q + 1)} />
                </div>
              ))}
            </div>
          ))}

          {step === "checkout" && (
            <div className="flex flex-col gap-4">
              {booking && (
                <div className="rounded-2xl p-4" style={{ background: "#FBEFD9", border: `1px solid ${P.saff}` }}>
                  <div className="font-extrabold mb-1" style={{ color: "#8A5A12" }}>{t("bookingFor")}</div>
                  <div className="font-bold" style={{ color: P.txt }}>{pickL(booking.roomName, lang)} · {t("upTo")} {booking.capacity}</div>
                  <div className="text-sm mt-1" style={{ color: P.sub }}>{booking.date} · {booking.time}{booking.guests ? ` · ${booking.guests}` : ""}</div>
                  <div className="text-sm" style={{ color: P.sub }}>{booking.phone}</div>
                  <div className="text-xs mt-2" style={{ color: "#8A5A12" }}>{entries.length === 0 ? t("roomOnly") : ""}</div>
                </div>
              )}
              {!booking && (
              <div>
                <div className="text-sm font-bold mb-2" style={{ color: P.txt }}>{t("orderType")}</div>
                <div className="grid grid-cols-3 gap-2">
                  {[["table", t("atTableShort")], ["pickup", t("pickup")], ["delivery", t("delivery")]].map(([v, label]) => (
                    <button key={v} onClick={() => { setType(v); setErr(""); }} className="rounded-xl py-3.5 px-1 font-bold text-xs flex flex-col items-center gap-1"
                      style={{ background: type === v ? P.ink : P.card, color: type === v ? "#fff" : P.txt, border: `1px solid ${type === v ? P.ink : P.line}` }}>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                {takeawayBlockedItems.length > 0 && (
                  <div role="alert" className="mt-3 text-sm font-bold rounded-xl px-3 py-2.5" style={{ background: "#FAE5E3", color: "#933A34" }}>
                    {takeawayBlockedMessage}
                  </div>
                )}
              </div>
              )}
              {!booking && type === "table" && (
                <div>
                  <div className="text-sm font-bold mb-1.5" style={{ color: P.txt }}>{t("tableNo")}</div>
                  <div className="grid grid-cols-5 gap-2">
                    {Array.from({ length: 30 }, (_, i) => String(i + 1)).map((n) => {
                      const on = table === n;
                      return (
                        <button key={n} type="button" onClick={() => setTable(n)}
                          className="rounded-xl py-2.5 font-extrabold text-sm"
                          style={{ background: on ? P.ink : P.card, color: on ? "#fff" : P.txt, border: `1px solid ${on ? P.ink : P.line}` }}>
                          {n}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {!booking && type === "table" && (
                <label className="block">
                  <div className="text-sm font-bold mb-1.5" style={{ color: P.txt }}>
                    {t("phone")}
                  </div>
                  <PhoneInput value={phone} onChange={setPhone} lang={lang} />
                </label>
              )}
              {!booking && (type === "pickup" || type === "delivery") && (
                <>
                  <Field label={t("yourName")} value={name} onChange={setName} ph="Aza" />
                  <label className="block">
                    <div className="text-sm font-bold mb-1.5" style={{ color: P.txt }}>{t("phone")}</div>
                    <PhoneInput value={phone} onChange={setPhone} lang={lang} />
                  </label>
                </>
              )}
              {!booking && type === "delivery" && (
                <div className="flex flex-col gap-2">
                  <button type="button" onClick={() => setMapOpen(true)}
                    className="py-2.5 rounded-xl font-extrabold text-xs flex items-center justify-center gap-1.5"
                    style={{ background: P.brand, color: "#fff" }}>
                    {t("mapPickBtn")}
                  </button>
                  <MapPicker open={mapOpen} onClose={() => setMapOpen(false)} onPick={pickFromMap}
                    lang={lang} t={t} initial={location} deliveryCfg={deliveryCfg} />

                  {location && (
                    <>
                      {address && (
                        <div className="text-xs font-bold rounded-lg px-3 py-2" style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}>
                          {address}
                        </div>
                      )}
                      <div className="text-xs font-bold rounded-lg px-3 py-2 flex items-center justify-between gap-2" style={{ background: "#E9F1DF", color: "#3F7A2E" }}>
                        <span>✓ {t("gpsAttached")} · {location.lat.toFixed(5)}, {location.lng.toFixed(5)}</span>
                        <button type="button" onClick={() => setLocation(null)} aria-label="remove" style={{ color: "#933A34", fontWeight: 800 }}>✕</button>
                      </div>
                      <div className="text-xs font-extrabold rounded-lg px-3 py-2"
                        style={deliveryFee === null
                          ? { background: "#FAE5E3", color: "#933A34" }
                          : deliveryFee === 0
                            ? { background: "#E9F1DF", color: "#3F7A2E" }
                            : { background: "#FBEFD9", color: "#8A5A12" }}>
                        {deliveryFee === null ? <>{t("deliveryTooFar")}</>
                          : deliveryFee === 0 ? <>{t("deliveryFree")}</>
                          : <>{t("deliveryFeeLbl")}: +{fmt(deliveryFee)} · {t("inclInTotal")}</>}
                      </div>
                    </>
                  )}
                  <div className="text-xs rounded-lg px-3 py-2" style={{ background: "#FBEFD9", color: "#8A5A12" }}>
                    {t("addrDetailsNote")}
                  </div>
                  <div className="text-xs" style={{ color: P.sub }}>{t("courierCall")}</div>
                </div>
              )}
              {!booking && (type === "pickup" || type === "delivery") && (
                <div>
                  <div className="text-sm font-bold mb-2" style={{ color: P.txt }}>{t("whenLabel")}</div>
                  <div className="grid grid-cols-2 gap-2">
                    {[["asap", t("asap")], ["time", t("forTime")]].map(([v, label]) => (
                      <button key={v} type="button" onClick={() => setSchedMode(v)}
                        className="rounded-xl py-2.5 px-1 font-bold text-xs"
                        style={{ background: schedMode === v ? P.ink : P.card, color: schedMode === v ? "#fff" : P.txt, border: `1px solid ${schedMode === v ? P.ink : P.line}` }}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {schedMode === "time" && (
                    <div className="flex gap-2 items-center mt-2">
                      <select value={schedH} onChange={(e) => setSchedH(e.target.value)}
                        className="flex-1 rounded-xl px-3 py-2.5 text-sm font-bold outline-none appearance-none text-center"
                        style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}>
                        <option value="" disabled>{lang === "en" ? "Hour" : "Час"}</option>
                        {[...Array.from({ length: 16 }, (_, i) => String(i + 8).padStart(2, "0")), "00", "01"].map((h) => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                      <span className="font-extrabold text-lg" style={{ color: P.txt }}>:</span>
                      <select value={schedM} onChange={(e) => setSchedM(e.target.value)}
                        className="flex-1 rounded-xl px-3 py-2.5 text-sm font-bold outline-none appearance-none text-center"
                        style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}>
                        <option value="" disabled>{lang === "en" ? "Min" : "Мин"}</option>
                        {["00", "10", "15", "20", "30", "40", "45", "50"].map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}
              {!booking && (
                <section className="rounded-lg p-4" style={{ background: P.card, border: `1px solid ${P.line}` }}>
                  <div className="font-extrabold text-sm" style={{ color: P.txt }}>
                    {L3(lang, "Website bonuses", "Бонусы сайта", "Сайт бонустары")}
                  </div>
                  {loyalty ? (
                    <div className="mt-3 rounded-xl p-3.5" style={{ background: P.bone, border: `1px solid ${P.line}` }}>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-extrabold" style={{ color: P.green }}>
                            ✓ {L3(lang, "Bonus ID connected", "Бонусный ID подключён", "Бонус ID қосылды")}
                          </div>
                          <div className="text-sm font-extrabold mt-1 tracking-wide" style={{ color: P.txt }}>{loyalty.maskedCode}</div>
                          <div className="text-xs mt-0.5" style={{ color: P.sub }}>
                            {L3(lang, "Available", "Доступно", "Қолжетімді")}: {fmt(loyalty.balance || 0)}
                          </div>
                        </div>
                        <button type="button" onClick={() => {
                          forgetLoyalty();
                          setLoyaltyMode("existing");
                          setUseBonus(false);
                          setBonusToUse(0);
                        }} className="shrink-0 rounded-lg px-3 py-2 text-xs font-extrabold"
                          style={{ background: P.card, border: `1px solid ${P.line}`, color: P.tealD }}>
                          {L3(lang, "Another ID", "Другой ID", "Басқа ID")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3">
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          ["enroll", L3(lang, "Create ID", "Создать ID", "ID жасау")],
                          ["existing", L3(lang, "I have ID", "У меня есть ID", "ID бар")],
                          ["none", L3(lang, "No bonuses", "Без бонусов", "Бонуссыз")],
                        ].map(([mode, label]) => (
                          <button key={mode} type="button" onClick={() => {
                            setLoyaltyMode(mode);
                            setLoyaltyMessage("");
                            setUseBonus(false);
                          }} className="rounded-lg py-2.5 px-1 text-[11px] font-extrabold"
                            style={{
                              background: loyaltyMode === mode ? P.ink : P.bone,
                              color: loyaltyMode === mode ? "#fff" : P.txt,
                              border: `1px solid ${loyaltyMode === mode ? P.ink : P.line}`,
                            }}>
                            {label}
                          </button>
                        ))}
                      </div>
                      {loyaltyMode === "enroll" && (
                        <div className="text-xs mt-3 rounded-lg px-3 py-2.5" style={{ background: "#E9F1DF", color: "#3F7A2E" }}>
                          {L3(
                            lang,
                            "We will create a 9-digit bonus ID after this order. Save it securely—lost IDs cannot be recovered.",
                            "После заказа мы создадим 9-значный бонусный ID. Сохраните его — потерянный ID восстановить нельзя.",
                            "Тапсырыстан кейін 9 таңбалы бонус ID жасаймыз. Оны сақтаңыз — жоғалған ID қалпына келмейді.",
                          )}
                        </div>
                      )}
                      {loyaltyMode === "existing" && (
                        <div className="mt-3">
                          <div className="flex gap-2">
                            <input value={loyaltyInput} maxLength={9} autoCapitalize="off" autoCorrect="off" spellCheck={false}
                              onChange={(event) => setLoyaltyInput(normalizeLoyaltyCodeInput(event.target.value))}
                              placeholder="123456789" className="min-w-0 flex-1 rounded-lg px-3 py-2.5 text-center font-extrabold tracking-widest outline-none"
                              style={{ background: P.bone, border: `1px solid ${P.line}`, color: P.txt }} />
                            <button type="button" onClick={connectEnteredLoyalty}
                              disabled={!isValidLoyaltyCode(loyaltyInput) || connectingLoyalty}
                              className="px-3 rounded-lg text-xs font-extrabold"
                              style={{ background: P.teal, color: "#fff", opacity: !isValidLoyaltyCode(loyaltyInput) || connectingLoyalty ? 0.5 : 1 }}>
                              {connectingLoyalty ? "…" : L3(lang, "Connect", "Подключить", "Қосу")}
                            </button>
                          </div>
                          {loyaltyMessage && <div role="alert" className="text-xs font-bold mt-2" style={{ color: P.red }}>{loyaltyMessage}</div>}
                        </div>
                      )}
                    </div>
                  )}
                  {activeLoyalty && bonusLimit > 0 && (
                    <button type="button" onClick={() => {
                      const next = !useBonus;
                      setUseBonus(next);
                      if (next && !bonusToUse) setBonusToUse(bonusLimit);
                    }} className="w-full mt-3 rounded-xl py-3 text-sm font-extrabold flex items-center justify-center gap-2"
                      style={{
                        background: useBonus ? P.teal : P.bone,
                        color: useBonus ? "#fff" : P.txt,
                        border: `1px solid ${useBonus ? P.teal : P.line}`,
                      }}>
                      {useBonus ? "✓ " : ""}{L3(lang, "Use bonuses", "Списать бонусы", "Бонустарды жұмсау")}
                    </button>
                  )}
                  {activeLoyalty && useBonus && bonusLimit > 0 && (
                    <div className="mt-3 rounded-xl p-3.5" style={{ background: P.bone, border: `1px solid ${P.line}` }}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold" style={{ color: P.sub }}>
                          {L3(lang, "Bonuses to use", "Списать бонусов", "Жұмсалатын бонус")}
                        </span>
                        <span className="text-base font-extrabold" style={{ color: P.teal }}>{fmt(bonusUsed)}</span>
                      </div>
                      <input type="range" min="0" max={bonusLimit} step="1" value={bonusUsed}
                        aria-label={L3(lang, "Bonuses to use", "Сколько бонусов списать", "Жұмсалатын бонустар")}
                        onChange={(event) => setBonusToUse(Number(event.target.value))}
                        className="w-full" style={{ accentColor: P.teal }} />
                      <div className="flex items-center justify-between mt-1.5">
                        <button type="button" onClick={() => setBonusToUse(0)}
                          className="text-xs font-bold" style={{ color: P.sub }}>0 ₸</button>
                        <button type="button" onClick={() => setBonusToUse(bonusLimit)}
                          className="text-xs font-extrabold" style={{ color: P.tealD }}>
                          {L3(lang, "Max", "Максимум", "Максимум")}: {fmt(bonusLimit)}
                        </button>
                      </div>
                    </div>
                  )}
                  {(activeLoyalty || loyaltyMode === "enroll") && (
                    <div className="text-xs font-bold mt-3" style={{ color: P.green }}>
                      +{fmt(bonusPreview)} {L3(lang, "pending after completion", "будет начислено после завершения", "аяқталғаннан кейін есептеледі")}
                    </div>
                  )}
                </section>
              )}
              <Field label={t("comment")} value={comment} onChange={setComment} ph={t("commentPh")} area />
              {/* Turnstile widget — rendered explicitly via useEffect above */}
              <div ref={turnstileRef} />
              <AnimatePresence>
                {err && (
                  <motion.div role="alert" initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    transition={{ duration: reducedMotion ? 0.12 : MOTION.duration.micro }}
                    className="text-sm font-bold rounded-lg px-3 py-2" style={{ background: "#FAE5E3", color: "#933A34" }}>{err}</motion.div>
                )}
              </AnimatePresence>
              <div className="rounded-xl p-3 text-sm" style={{ background: P.card, border: `1px solid ${P.line}` }}>
                {entries.map(({ cartId, item, price, sizeLabel, q }) => (
                  <div key={cartId} className="flex justify-between py-0.5">
                    <span style={{ color: P.sub }}>{pickL(item.name, lang)}{sizeLabel ? ` (${sizeLabel})` : ""} × {q}</span>
                    <span className="font-bold" style={{ color: P.txt }}>{fmt(price * q)}</span>
                  </div>
                ))}
                {subtotal > 0 && (
                  <div className="mt-2 pt-2" style={{ borderTop: `1px solid ${P.line}` }}>
                    <PriceBreakdown subtotal={subtotal} t={t} withFee={feeApplies}
                      deliveryFee={!booking && type === "delivery" && deliveryFee > 0 ? deliveryFee : 0}
                      bonusUsed={bonusUsed} lang={lang} />
                  </div>
                )}
              </div>
            </div>
          )}

          {step === "done" && live && (
            <div className="text-center mt-8">
              <div className="font-extrabold text-xl mt-2" style={{ fontFamily: FONT_DISPLAY, color: P.txt }}>
                {t("orderNo")} №{live.num}
              </div>
              <div className="text-sm mt-2" style={{ color: P.sub }}>
                {live.type === "booking" ? `${live.booking ? pickL(live.booking.roomName, lang) : ""} · ${live.booking ? live.booking.date : ""} ${live.booking ? live.booking.time : ""}`
                  : live.type === "table" ? `${t("placedTable")} №${live.table}.`
                  : live.type === "delivery" ? t("placedDelivery")
                  : t("placedPickup")}
              </div>
              {live.type === "delivery" && live.address && (
                <div className="text-xs mt-2 rounded-lg px-3 py-2 inline-block" style={{ background: P.bone, color: P.txt }}>
                  {live.address}
                </div>
              )}
              {(live.total || 0) > 0 && (
                <div className="mt-4 mx-auto text-left rounded-xl p-4" style={{ background: P.card, border: `1px solid ${P.line}`, maxWidth: 280 }}>
                  <OrderPriceBreakdown order={live} t={t} lang={lang} />
                </div>
              )}
              {(live.bonusPending || live.bonusEarned || 0) > 0 && (
                <div className="mt-3 mx-auto rounded-lg px-4 py-3 text-sm font-extrabold"
                  style={{ background: "#E9F1DF", color: "#3F7A2E", border: "1px solid #BFD8A8", maxWidth: 300 }}>
                  {live.status === "done"
                    ? `+${fmt(live.bonusEarned || 0)} ${L3(lang, "bonuses added", "бонусов начислено", "бонус есептелді")}`
                    : `+${fmt(live.bonusPending || 0)} ${L3(lang, "after completion", "после завершения", "аяқталғаннан кейін")}`}
                </div>
              )}
              {newLoyaltyCode && (
                <div className="mt-4 mx-auto rounded-xl p-4 text-left"
                  style={{ background: P.ink, color: "#fff", maxWidth: 320, border: "2px solid #E7C995" }}>
                  <div className="text-xs font-extrabold" style={{ color: "#E7C995" }}>
                    {L3(lang, "Your new private bonus ID", "Ваш новый секретный бонусный ID", "Жаңа құпия бонус ID")}
                  </div>
                  <div className="font-extrabold tracking-[0.18em] mt-2 text-center" style={{ fontSize: 27 }}>
                    {newLoyaltyCode}
                  </div>
                  <div className="text-xs mt-3" style={{ color: "rgba(255,255,255,.76)" }}>
                    {L3(
                      lang,
                      "Save it securely. If you lose it and this browser is cleared, the bonuses cannot be recovered.",
                      "Сохраните ID. Если вы потеряете его и данные браузера будут удалены, бонусы восстановить нельзя.",
                      "ID-ны сақтаңыз. Оны жоғалтып, браузер деректері өшсе, бонустар қалпына келмейді.",
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <button type="button" onClick={copyNewLoyaltyCode} className="py-2.5 rounded-lg text-xs font-extrabold" style={{ background: P.teal, color: "#fff" }}>
                      {L3(lang, "Copy ID", "Копировать ID", "ID көшіру")}
                    </button>
                    <button type="button" onClick={downloadNewLoyaltyCode} className="py-2.5 rounded-lg text-xs font-extrabold" style={{ background: "#fff", color: P.ink }}>
                      {L3(lang, "Download", "Скачать", "Жүктеу")}
                    </button>
                  </div>
                </div>
              )}
              {live.type === "booking" && live.callConfirmed && (
                <div className="mt-4 mx-auto rounded-xl px-4 py-3 text-sm font-extrabold" style={{ background: "#E9F1DF", color: "#3F7A2E", border: "1px solid #BFD8A8", maxWidth: 300 }}>
                  {t("bookingConfirmed")}
                </div>
              )}
              {live.status === "awaiting_confirmation" && kaspiUrl && (
                <div className="mt-4 mx-auto rounded-xl p-4 text-left" style={{ background: "#FBEFD9", border: "1px solid #E8D9B5", maxWidth: 300 }}>
                  <div className="text-sm font-extrabold" style={{ color: "#8A5A12" }}>
                    {t("kaspiAmount")}: {fmt(live.total || 0)}
                  </div>
                  <div className="text-xs mt-1 font-bold" style={{ color: "#8A5A12" }}>
                    {t("kaspiComment")}: №{live.num}
                  </div>
                  <div className="text-xs mt-2" style={{ color: "#8A5A12" }}>{t("awaitingNote")}</div>
                  <button onClick={() => window.open(kaspiUrl, "_blank", "noopener,noreferrer")}
                    className="w-full mt-3 py-2.5 rounded-xl font-extrabold" style={{ background: "#F14635", color: "#fff" }}>
                    {t("openKaspi")} →
                  </button>
                </div>
              )}
              {live.status === "cooking" && live.estimated_ready_at ? (
                <div><PrepCountdownCustomer live={live} t={t} /></div>
              ) : null}
              <OrderTimeline o={live} t={t} />
              {ntfs.length > 0 && (
                <div className="mt-4 mx-auto text-left rounded-xl p-4" style={{ background: P.card, border: `1px solid ${P.line}`, maxWidth: 280 }}>
                  <div className="text-xs font-bold uppercase tracking-wide mb-1" style={{ color: P.sub }}>{t("notifTitle")}</div>
                  {ntfs.slice().reverse().map((n) => (
                    <div key={n.id} className="flex items-start gap-2 py-1.5" style={{ borderTop: `1px solid ${P.line}` }}>
                      {!n.read_status && <span className="mt-1.5 rounded-full flex-shrink-0" style={{ background: P.teal, width: 8, height: 8 }} />}
                      <div className="text-sm" style={{ color: P.txt, fontWeight: n.read_status ? 500 : 800 }}>
                        {ntfText(n, live, t)}
                        <div className="text-xs mt-0.5" style={{ color: P.sub, fontWeight: 500 }}>{timeOf(n.ts)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-6">
                <div className="flex justify-center mb-2">
                  <button onClick={doRefreshOrder} disabled={refreshingOrder}
                    className="text-xs font-bold px-4 py-1.5 rounded-full inline-flex items-center justify-center gap-1.5 min-w-[190px] text-center"
                    style={{
                      background: refreshingOrder ? P.teal : P.bone,
                      color: refreshingOrder ? "#fff" : P.txt,
                      border: `1px solid ${refreshingOrder ? P.teal : P.line}`,
                      opacity: refreshingOrder ? 0.85 : 1,
                    }}>
                    <span style={{ display: "inline-block", animation: refreshingOrder ? "spin 0.7s linear infinite" : "none" }}>↻</span>
                    {refreshingOrder ? (lang === "en" ? "Refreshing…" : "Обновляем…") : t("refresh")}
                  </button>
                </div>
                <button onClick={() => { resetAfterOrder(); setStep("cart"); setTable(""); setComment(""); setAddress(""); setLocation(null); setSchedMode("asap"); setSchedH(""); setSchedM(""); setUseBonus(false); setBonusToUse(0); setNewLoyaltyCode(""); setConsent(false); setConsentError(false); setConsentShake(false); }}
                  className="font-bold text-sm px-4 py-2 rounded-full" style={{ background: P.ink, color: "#fff" }}>
                  {t("newOrder")}
                </button>
              </div>
            </div>
          )}
            </motion.div>
          </AnimatePresence>
        </div>

        {step !== "done" && (entries.length > 0 || (booking && step === "checkout")) && (
          <div className="px-5 py-4" style={{ borderTop: `1px solid ${P.line}`, background: P.card }}>
            {subtotal > 0 && (
              <div className="mb-3"><PriceBreakdown subtotal={subtotal} t={t} withFee={feeApplies}
                deliveryFee={!booking && type === "delivery" && deliveryFee > 0 ? deliveryFee : 0}
                bonusUsed={bonusUsed} lang={lang} /></div>
            )}
            {step === "cart" ? (
              <button onClick={() => setStep("checkout")} className="w-full py-3 rounded-xl font-extrabold" style={{ background: P.teal, color: "#fff" }}>
                {t("checkout")} →
              </button>
            ) : (
              <div className="flex flex-col gap-2">
                {/* Required personal-data consent — a distinct highlighted step,
                    not a footnote. The privacy link opens the full policy above
                    the drawer without losing the checkout or toggling the box. */}
                <label className={`consent-box flex items-start gap-3 rounded-xl px-3.5 py-3 cursor-pointer select-none${consentShake ? " consent-shake" : ""}`}
                  style={{
                    background: consentError ? "rgba(178,58,47,.08)" : "rgba(116,36,39,.06)",
                    border: `1.5px solid ${consentError ? P.red : consent ? P.teal : "#E2CDBA"}`,
                    transition: "border-color .15s, background-color .15s",
                  }}>
                  <input type="checkbox" checked={consent}
                    onChange={(e) => { setConsent(e.target.checked); if (e.target.checked) setConsentError(false); }}
                    className="sr-only" />
                  <span aria-hidden="true" className="consent-tick flex-shrink-0 flex items-center justify-center rounded-md"
                    style={{
                      width: 26, height: 26, fontSize: 16, fontWeight: 900, lineHeight: 1,
                      background: consent ? P.teal : "#fff",
                      border: `2px solid ${consent ? P.teal : (consentError ? P.red : "#D8BE9A")}`,
                      color: "#fff", transition: "all .15s",
                    }}>
                    {consent ? "✓" : ""}
                  </span>
                  <span className="text-sm font-bold leading-snug" style={{ color: P.txt }}>
                    {t("consentPrefix")}
                    <button type="button" onClick={(e) => { e.preventDefault(); openPrivacy && openPrivacy(); }}
                      className="underline font-extrabold p-0" style={{ background: "none", color: P.tealD }}>
                      {t("privacyPolicy")}
                    </button>
                    {(T[lang] && T[lang].consentSuffix) || ""}
                  </span>
                </label>
                <AnimatePresence>
                {consentError && (
                  <motion.div role="alert" initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    transition={{ duration: reducedMotion ? 0.12 : MOTION.duration.micro }}
                    className="text-xs font-bold rounded-lg px-3 py-2" style={{ background: "#FAE5E3", color: "#933A34" }}>
                    {t("consentNeed")}
                  </motion.div>
                )}
                </AnimatePresence>
                {(!booking || entries.length > 0) && (
                  <button onClick={returnToCart} className="w-full py-2.5 rounded-xl font-bold" style={{ background: P.bone, border: `1px solid ${P.line}`, color: P.txt }}>
                    ← {t("back")}
                  </button>
                )}
                {/* Not hard-disabled on !consent so a tap can trigger the shake;
                    submitOrder guards internally, so it stays functionally locked. */}
                <button disabled={sending} aria-disabled={!consent} onClick={submitOrder}
                  className="w-full py-3 rounded-xl font-extrabold flex items-center justify-center gap-2"
                  style={{
                    background: isClosed ? P.sub : !consent ? "#CFC5BA" : (!booking && kaspiUrl) ? "#F14635" : P.teal,
                    color: "#fff", opacity: sending ? 0.6 : 1,
                    cursor: (isClosed || !consent) ? "not-allowed" : "pointer",
                    transition: "background-color .15s",
                  }}>
                  {sending ? "…" : <span>{booking ? t("bookNoPay") : (kaspiUrl ? t("payKaspi") : t("placeOrderFinal"))}</span>}
                </button>
              </div>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
      )}
    </AnimatePresence>
  );
}

function Field({ label, value, onChange, ph, area }) {
  const cls = "w-full rounded-xl px-3 py-2.5 text-sm font-medium outline-none";
  const st = { background: P.card, border: `1px solid ${P.line}`, color: P.txt };
  return (
    <label className="block">
      <div className="text-sm font-bold mb-1.5" style={{ color: P.txt }}>{label}</div>
      {area ? (
        <textarea rows={2} className={cls} style={st} placeholder={ph} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={cls} style={st} placeholder={ph} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

// Phone field with a fixed "+7 (" prefix shown outside the editable area,
// so the customer only ever types the digits inside the brackets onward.
function PhoneInput({ value, onChange, lang }) {
  // value is stored WITHOUT the leading "+7", e.g. "(701) 234-56-78"
  return (
    <div style={{ position: "relative" }}>
      <div className="flex items-center rounded-xl overflow-hidden" style={{ border: `1px solid ${P.line}`, background: P.card }}>
        <span className="font-bold text-lg pl-4 pr-1 select-none" style={{ color: P.sub }}>+7</span>
        <input
          value={value}
          onChange={(e) => onChange(formatKzPhoneBody(e.target.value))}
          inputMode="tel"
          placeholder="(___) ___-__-__"
          className="flex-1 py-3 pr-10 text-lg font-bold tracking-wide outline-none"
          style={{ color: P.txt, background: "transparent", border: "none" }}
        />
      </div>
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          style={{
            position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
            background: "none", border: "none", color: P.sub, fontWeight: 800,
            fontSize: 20, cursor: "pointer", lineHeight: 1
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

// Formats just the part AFTER "+7": "(7xx) xxx-xx-xx".
// Accepts raw digit input (typing one digit at a time, or pasting a full number) and re-formats every time.
function formatKzPhoneBody(input) {
  let d = input.replace(/\D/g, "");
  // Only strip a leading country-code digit when a FULL number was pasted at once
  // (11 digits starting with 7 or 8) — never when the person is just typing normally,
  // so typing "7" as the first digit inside the brackets works correctly.
  if (d.length === 11 && (d.startsWith("7") || d.startsWith("8"))) d = d.slice(1);
  d = d.slice(0, 10); // 10 digits after +7: xxx xxx xx xx
  let out = "";
  if (d.length > 0) out += "(" + d.slice(0, 3);
  if (d.length >= 3) out += ")";
  if (d.length > 3) out += " " + d.slice(3, 6);
  if (d.length > 6) out += "-" + d.slice(6, 8);
  if (d.length > 8) out += "-" + d.slice(8, 10);
  return out;
}
// Full E.164-ish number for storage/display: "+7" + body digits
const phoneFull = (body) => "+7" + body.replace(/\D/g, "");
const phoneBodyComplete = (body) => body.replace(/\D/g, "").length === 10;

/* ── room booking wizard ─────────────────────────────────────────────── */

function BookingWizard({ open, onClose, lang, t, onProceed, cafeInfo }) {
  // Table capacities the staff have put on the stop-list are hidden here so
  // customers can't pick them (Part 2). tableStop lives in the same settings
  // blob as the open/closed status.
  const stopped = (cafeInfo && cafeInfo.tableStop) || [];
  const availableTables = TABLES.filter((tbl) => !stopped.includes(tbl.id));
  const STEPS = ["schedule", "rooms", "phone", "bridge"];
  const [bStep, setBStep] = useState("schedule"); // schedule | rooms | phone | bridge
  const [room, setRoom] = useState(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [guests, setGuests] = useState("");
  const [phoneBody, setPhoneBody] = useState(""); // digits after +7
  const [err, setErr] = useState("");
  // Per-room slot info for the chosen date+time: { available, sitUntil }.
  // sitUntil = the client must free the table by then (a later booking needs
  // it, minus the cleaning buffer); missing entry = fully free.
  const [avail, setAvail] = useState({});
  const [availLoading, setAvailLoading] = useState(false);

  useEffect(() => { if (open) { setBStep("schedule"); setRoom(null); setDate(""); setTime(""); setGuests(""); setPhoneBody(""); setErr(""); setAvail({}); } }, [open]);

  // fetch which rooms are taken for the chosen slot, whenever we land on the rooms step
  useEffect(() => {
    if (open && bStep === "rooms" && date && time) {
      setAvailLoading(true);
      apiCheckAvailability(date, time).then((rooms) => { setAvail(rooms || {}); setAvailLoading(false); });
    }
  }, [open, bStep, date, time]);

  if (!open) return null;
  const today = new Date().toISOString().split("T")[0];

  const roomBusy = (id) => !!(avail[id] && avail[id].available === false);
  const sitUntilOf = (id) => (avail[id] && avail[id].sitUntil) || null;
  const untilText = (hhmm) => (lang === "kz" ? `${hhmm} дейін` : `${t("until")} ${hhmm}`);
  const isUnavailable = (r) => roomBusy(r.id) || (guests && Number(guests) > r.capacity);
  const booking = () => ({
    roomId: room.id, roomName: room.name, capacity: room.capacity,
    date, time, guests: guests || null, phone: phoneFull(phoneBody),
    // Departure cap when a later booking needs this table; the server
    // recomputes and enforces this on placement regardless.
    endTime: sitUntilOf(room.id),
  });

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label={t("bookRoom")}>
      <div className="absolute inset-0" style={{ background: "rgba(14,22,32,.55)" }} onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full sm:w-[440px] flex flex-col" style={{ background: P.bone }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${P.line}` }}>
          <div className="font-extrabold text-lg" style={{ fontFamily: FONT_DISPLAY, color: P.txt }}>{t("bookRoom")}</div>
          <button onClick={onClose} aria-label="close" className="w-9 h-9 rounded-full font-bold" style={{ background: P.card, border: `1px solid ${P.line}` }}>✕</button>
        </div>

        {/* progress */}
        <div className="flex gap-1.5 px-5 pt-4">
          {STEPS.map((s, i) => (
            <div key={s} className="h-1.5 flex-1 rounded-full" style={{ background: STEPS.indexOf(bStep) >= i ? P.teal : P.line }} />
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {bStep === "schedule" && (
            <>
              {/* 1. DATE INPUT */}
              <div className="mb-4">
                <div className="text-sm font-bold mb-1.5" style={{ color: P.txt }}>{t("date")}</div>
                <input
                  type="date"
                  min={today}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full rounded-xl px-3 py-2.5 text-sm font-medium outline-none"
                  style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}
                />
              </div>

              {/* 2. TIME INPUT */}
              <div className="mb-4">
                <div className="text-sm font-bold mb-1.5" style={{ color: P.txt }}>{t("time")}</div>
                <div className="flex gap-2 items-center">
                  <select value={time.split(":")[0] || ""}
                    onChange={(e) => setTime(e.target.value + ":" + (time.split(":")[1] || "00"))}
                    className="flex-1 rounded-xl px-3 py-2.5 text-sm font-bold outline-none appearance-none text-center"
                    style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}>
                    <option value="" disabled>{lang === "en" ? "Hour" : "Час"}</option>
                    {[...Array.from({ length: 16 }, (_, i) => String(i + 8).padStart(2, "0")), "00", "01"].map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                  <span className="font-extrabold text-lg" style={{ color: P.txt }}>:</span>
                  <select value={time.split(":")[1] || ""}
                    onChange={(e) => setTime((time.split(":")[0] || "08") + ":" + e.target.value)}
                    className="flex-1 rounded-xl px-3 py-2.5 text-sm font-bold outline-none appearance-none text-center"
                    style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}>
                    <option value="" disabled>{lang === "en" ? "Min" : "Мин"}</option>
                    {["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"].map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div className="text-xs mt-1.5" style={{ color: P.sub }}>
                  {lang === "en" ? "Working hours 08:00–01:00" : lang === "kz" ? "Жұмыс уақыты 08:00–01:00" : "Время работы 08:00–01:00"}
                </div>
              </div>

              {/* 3. GUESTS INPUT */}
              <label className="block">
                <div className="text-sm font-bold mb-1.5" style={{ color: P.txt }}>{t("guests")}</div>
                <input inputMode="numeric" value={guests} onChange={(e) => setGuests(e.target.value.replace(/\D/g, "").slice(0, 3))}
                  placeholder={t("guests")} className="w-full rounded-xl px-3 py-2.5 text-sm font-medium outline-none" style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }} />
              </label>
            </>
          )}

          {bStep === "rooms" && (
            <>
              <div className="rounded-xl p-3 mb-4 text-sm font-bold flex items-center justify-between" style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}>
                <span>{date} · {time}{guests ? ` · ${guests}` : ""}</span>
                <button onClick={() => setBStep("schedule")} className="text-xs font-bold" style={{ color: P.teal }}>✎</button>
              </div>
              <div className="font-extrabold mb-3" style={{ color: P.txt }}>{t("pickRoom")}{availLoading ? ` · ${t("checking")}` : ""}</div>
              {availableTables.length === 0 && (
                <div className="rounded-xl px-3 py-3 text-sm font-bold" style={{ background: "#FAE5E3", color: "#933A34" }}>{t("allTablesStopped")}</div>
              )}
              <div className="flex flex-col gap-3">
                {availableTables.map((r) => {
                  const off = isUnavailable(r);
                  return (
                    <button key={r.id} disabled={off} onClick={() => { setRoom(r); setBStep("phone"); }}
                      className="flex items-center gap-3 rounded-2xl p-4 text-left" style={{ background: P.card, border: `1px solid ${room?.id === r.id ? P.teal : P.line}`, opacity: off ? 0.55 : 1, cursor: off ? "not-allowed" : "pointer" }}>
                      <div className="flex-1">
                        <div className="font-extrabold" style={{ color: P.txt }}>{pickL(r.name, lang)}</div>
                        <div className="text-sm font-bold mt-0.5" style={{ color: off ? P.sub : P.teal }}>{t("upTo")} {r.capacity} {t("people")}</div>
                      </div>
                      {off
                        ? <Pill bg="#FAE5E3" fg="#933A34">{roomBusy(r.id) ? t("busyAtTime") : t("tooSmall")}</Pill>
                        : sitUntilOf(r.id)
                          ? <Pill bg="#FBEFD9" fg="#8A5A12">{untilText(sitUntilOf(r.id))}</Pill>
                          : <span style={{ color: P.sub }}>→</span>}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {bStep === "phone" && (
            <>
              <div className="font-extrabold mb-1" style={{ color: P.txt }}>{t("yourPhone")}</div>
              <div className="text-sm mb-4" style={{ color: P.sub }}>{t("phoneNote")}</div>
              <PhoneInput value={phoneBody} onChange={setPhoneBody} lang={lang} />
              {err && <div className="text-sm font-bold rounded-lg px-3 py-2 mt-3" style={{ background: "#FAE5E3", color: "#933A34" }}>{err}</div>}
            </>
          )}

          {bStep === "bridge" && (
            <div className="text-center mt-6">
              <div className="font-extrabold text-xl mt-3" style={{ fontFamily: FONT_DISPLAY, color: P.txt }}>{t("preOrderTitle")}</div>
              <div className="text-sm mt-3 rounded-xl px-4 py-3 text-left" style={{ background: "#FBEFD9", color: "#8A5A12" }}>{t("preOrderNote")}</div>
              <div className="rounded-xl p-3 mt-4 text-sm text-left" style={{ background: P.card, border: `1px solid ${P.line}` }}>
                <div className="font-bold" style={{ color: P.txt }}>{room && pickL(room.name, lang)} · {t("upTo")} {room?.capacity}</div>
                <div className="text-xs mt-1" style={{ color: P.sub }}>{date} · {time}{room && sitUntilOf(room.id) ? `–${sitUntilOf(room.id)}` : ""} · +7{phoneBody}</div>
              </div>
              <button onClick={() => onProceed(booking(), true)}
                className="w-full mt-5 py-3 rounded-xl font-extrabold" style={{ background: P.teal, color: "#fff" }}>
                {t("goToMenu")}
              </button>
              <button onClick={() => onProceed(booking(), false)}
                className="w-full mt-2 py-3 rounded-xl font-bold text-sm" style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}>
                {t("skipFood")}
              </button>
            </div>
          )}
        </div>

        {/* footer nav */}
        {bStep !== "bridge" && (
          <div className="px-5 py-4 flex gap-2" style={{ borderTop: `1px solid ${P.line}`, background: P.card }}>
            {bStep !== "schedule" && (
              <button onClick={() => setBStep(bStep === "phone" ? "rooms" : "schedule")} className="px-4 py-3 rounded-xl font-bold" style={{ background: P.bone, border: `1px solid ${P.line}`, color: P.txt }}>
                ← {t("back")}
              </button>
            )}
            {bStep === "schedule" && (
              <button disabled={!date || !time || time.length < 5} onClick={() => setBStep("rooms")} className="flex-1 py-3 rounded-xl font-extrabold"
                style={{ background: (!date || !time) ? P.line : P.teal, color: "#fff" }}>
                {t("next")} →
              </button>
            )}
            {bStep === "phone" && (
              <button onClick={() => { if (!phoneBodyComplete(phoneBody)) return setErr(t("needPhone")); setErr(""); setBStep("bridge"); }}
                className="flex-1 py-3 rounded-xl font-extrabold" style={{ background: P.teal, color: "#fff" }}>
                {t("next")} →
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── guest site ──────────────────────────────────────────────────────── */

function GuestSite({ lang, setLang, t, menu, cart, setQty, openCart, cartCount, cartTotal, goAdmin, lastOrder, orders, openBoard, openPrivacy, cafeInfo, loyalty, openBonuses }) {
  const [activeCat, setActiveCat] = useState("all");
  const [q, setQ] = useState("");
  const reducedMotion = useReducedMotion();
  const heroRef = React.useRef(null);
  const cartTargetRef = React.useRef(null);
  const cartControls = useAnimationControls();
  const ambientActive = useAmbientVisibility(heroRef);
  const onCartArrive = useCallback(() => {
    cartControls.start(reducedMotion
      ? { opacity: [1, 0.72, 1], transition: { duration: 0.16 } }
      : { scale: [1, 1.04, 1], transition: { duration: 0.3, ease: MOTION.ease.enter } });
  }, [cartControls, reducedMotion]);
  const runCartFlight = useCartFlight({
    targetRef: cartTargetRef,
    reducedMotion,
    onArrive: onCartArrive,
  });
  const sectionChildMotion = reducedMotion ? reducedSectionVariants : sectionChildVariants;
  const catList = useMemo(() => orderedCats(menu), [menu]);

  const filtered = useMemo(() => menu.filter((m) => {
    if (activeCat !== "all" && m.cat !== activeCat) return false;
    if (q.trim()) {
      const s = q.toLowerCase();
      return m.name.en.toLowerCase().includes(s) || m.name.ru.toLowerCase().includes(s);
    }
    return true;
  }), [menu, activeCat, q]);

  // Matched by public order number: the sanitized guest list carries no ids.
  const live = lastOrder ? orders.find((o) => o.num === lastOrder.num) : null;
  // Only an order still in progress should occupy the bottom pill slot —
  // a finished order must not hide the "tap to order" nudge for a new cart.
  const activeLive = live && live.status !== "done" && live.status !== "cancelled" ? live : null;

    // Server-computed (see /api/settings/cafe → effectiveOpen): combines the
    // staff manual toggle with the real Almaty-time hours check, so this is
    // never derived from the visitor's own browser clock/timezone.
    const isClosed = cafeInfo ? cafeInfo.effectiveOpen === false : false;
    return (
    <div style={{ background: P.bone, minHeight: "100vh", color: P.txt, paddingTop: isClosed ? CLOSED_BANNER_H : 0 }}>
    {/* --- CLOSED BANNER --- */}
    {isClosed && (
      <div className="fixed top-0 left-0 right-0 z-50 text-center py-3 font-extrabold text-sm" style={{ background: "#fff", color: P.red, borderBottom: `2px solid ${P.red}`, height: CLOSED_BANNER_H }}>
        {lang === "ru" ? "Кафе сейчас закрыто." : lang === "kz" ? "Кафе қазір жабық." : "The cafe is currently closed."}
      </div>
    )}
    {/* --- END CLOSED BANNER --- */}

      {/* header — offset below the closed banner so the banner never covers
          the brand lockup (both are pinned to the top of the viewport) */}
      <motion.header className="sticky z-40"
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reducedMotion ? 0.14 : 0.45, ease: MOTION.ease.enter }}
        style={{ top: isClosed ? CLOSED_BANNER_H : 0, background: "rgba(250,245,236,.92)", backdropFilter: "blur(8px)", borderBottom: `1px solid ${P.line}` }}>
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <a href="#top" className="flex items-center no-underline" style={{ color: P.txt }}>
            <Logo h={40} responsive />
          </a>
          <nav className="hidden md:flex items-center gap-4 ml-4 text-sm font-bold">
            <a href="#menu" style={{ color: P.sub }} className="no-underline hover:opacity-70">{t("menu")}</a>
            <a href="#contacts" style={{ color: P.sub }} className="no-underline hover:opacity-70">{t("contacts")}</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <motion.button whileTap={{ scale: 0.95 }} onClick={() => setLang(nextLang(lang))} className="text-xs font-extrabold px-3 py-1.5 rounded-full"
              style={{ background: P.card, border: `1px solid ${P.line}` }}>
              {langCode(lang)}
            </motion.button>
            <motion.button ref={cartTargetRef} data-cart-target="true" animate={cartControls} whileTap={{ scale: 0.96 }} onClick={openCart}
              className="flex items-center gap-2 text-sm font-extrabold px-4 py-2 rounded-full" style={{ background: P.ink, color: "#fff" }}>
              {cartCount > 0 ? fmt(cartTotal) : t("cart")}
              <AnimatePresence mode="popLayout" initial={false}>
                {cartCount > 0 && (
                  <motion.span key={cartCount}
                    initial={reducedMotion ? { opacity: 0.72 } : { scale: 1 }}
                    animate={reducedMotion ? { opacity: 1 } : { scale: [1, 1.22, 1] }}
                    transition={reducedMotion ? { duration: 0.16 } : MOTION.spring.badge}
                    className="text-xs px-1.5 rounded-full" style={{ background: P.teal }}>{cartCount}</motion.span>
                )}
              </AnimatePresence>
            </motion.button>
            <motion.button whileTap={{ scale: 0.96 }} onClick={openBoard} className="flex items-center gap-2 text-sm font-extrabold px-4 py-2 rounded-full"
              style={{ background: P.teal, color: "#fff", boxShadow: "0 2px 12px rgba(116,36,39,.35)" }}>
              {t("allOrders")}
            </motion.button>
          </div>
        </div>
      </motion.header>

      {/* hero — the seal's own palette: a deep burgundy stage that fades into
          the feast photograph on the right, brass laurel sprigs echoing the
          wreath in the logo, and thin ivory arcs standing in for the seal's
          concentric rings. The photo already ships with a dark burgundy
          gradient baked into its left edge, so the mask blends seamlessly.
          If the image is missing it hides itself and the gradient carries. */}
      <section ref={heroRef} id="top" className="relative overflow-hidden" style={{ background: "linear-gradient(105deg, #1A1011 0%, #401113 46%, #742427 100%)" }}>
        {/* soft brass glow so the burgundy reads rich, not flat */}
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: "radial-gradient(ellipse 62% 78% at 34% 40%, rgba(201,154,90,.16), rgba(201,154,90,0) 64%)" }} />
        {/* thin concentric arcs, as on the seal */}
        <div className="absolute rounded-full pointer-events-none" style={{ width: 520, height: 520, left: -120, top: -420, border: "1.5px solid rgba(250,245,236,.14)" }} />
        <div className="absolute rounded-full pointer-events-none" style={{ width: 430, height: 430, right: "43%", top: -300, border: "1.5px solid rgba(201,154,90,.16)" }} />
        <div className="absolute rounded-full pointer-events-none" style={{ width: 420, height: 420, right: "23%", bottom: -310, border: "1.5px solid rgba(250,245,236,.08)" }} />
        {/* brass laurel sprigs from the wreath in the seal */}
        <AnimatedLaurel size={104} rotate={-18} opacity={0.3} style={{ left: -22, bottom: 40 }}
          drift="a" delay={0.36} reducedMotion={reducedMotion} ambientActive={ambientActive} />
        <AnimatedLaurel size={54} rotate={132} opacity={0.34} style={{ left: 74, bottom: 78 }}
          drift="b" delay={0.42} reducedMotion={reducedMotion} ambientActive={ambientActive} />
        <AnimatedLaurel size={44} rotate={-140} opacity={0.28} style={{ right: "45%", top: 34 }}
          drift="a" delay={0.48} reducedMotion={reducedMotion} ambientActive={ambientActive} />
        <AnimatedLaurel size={40} rotate={64} opacity={0.24} style={{ right: "7%", top: 46 }}
          drift="b" delay={0.54} reducedMotion={reducedMotion} ambientActive={ambientActive} />
        {/* the feast photograph, faded into the burgundy stage */}
        <motion.div className="hidden sm:block absolute pointer-events-none select-none"
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 24, scale: 1.035 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          transition={{ duration: reducedMotion ? 0.14 : 1, delay: reducedMotion ? 0 : 0.1, ease: MOTION.ease.enter }}
          style={{ right: 0, top: 0, bottom: 0, width: "61%", maxWidth: 900, zIndex: 1 }}>
          <img src={HERO_IMAGE} alt="" aria-hidden="true"
            onError={(e) => { e.currentTarget.style.display = "none"; }}
            className={`absolute inset-0 pointer-events-none select-none yusup-hero-photo ${ambientActive ? "" : "yusup-ambient-paused"}`}
            style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "right center", WebkitMaskImage: "linear-gradient(90deg, transparent 0%, rgba(0,0,0,.7) 13%, #000 30%, #000 100%)", maskImage: "linear-gradient(90deg, transparent 0%, rgba(0,0,0,.7) 13%, #000 30%, #000 100%)" }} />
        </motion.div>
        <div className="relative max-w-5xl mx-auto px-4 pt-10 pb-9 sm:py-12" style={{ zIndex: 2 }}>
          <div className="max-w-2xl sm:max-w-[56%]">
            <motion.div className="flex items-center gap-3 mb-4"
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reducedMotion ? 0.14 : 0.5, delay: reducedMotion ? 0 : 0.12, ease: MOTION.ease.enter }}>
              <Logo h={34} tone="light" wordmark={false} />
              <span className="text-xs font-extrabold tracking-widest uppercase" style={{ color: P.saff }}>{L3(lang, "Halal kitchen", "Халяльная кухня", "Халал ас")}</span>
            </motion.div>
            <motion.h1 className="leading-snug max-w-xl"
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reducedMotion ? 0.14 : 0.7, delay: reducedMotion ? 0 : 0.18, ease: MOTION.ease.enter }}
              style={{ fontFamily: FONT_DISPLAY, color: "#fff", fontSize: "clamp(23px,3.4vw,38px)", fontWeight: 700, letterSpacing: "-.01em" }}>
              {t("tagline")}
            </motion.h1>
            <motion.div className="mt-6 flex flex-wrap items-center gap-3"
              initial="hidden" animate="visible"
              variants={{ visible: { transition: { delayChildren: reducedMotion ? 0 : 0.48, staggerChildren: reducedMotion ? 0 : 0.07 } } }}>
              <motion.a href="#menu" whileTap={{ scale: 0.97 }}
                variants={{ hidden: reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0, transition: { duration: reducedMotion ? 0.14 : 0.52, ease: MOTION.ease.enter } } }}
                className="no-underline font-extrabold text-sm px-5 py-3 rounded-full" style={{ background: P.saff, color: P.txt, boxShadow: "0 12px 28px rgba(0,0,0,.32)" }}>
                {t("seeMenu")} ↓
              </motion.a>
              <motion.a href="tel:+77753798243" whileTap={{ scale: 0.97 }}
                variants={{ hidden: reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0, transition: { duration: reducedMotion ? 0.14 : 0.52, ease: MOTION.ease.enter } } }}
                className="no-underline font-extrabold text-sm px-5 py-3 rounded-full"
                style={{ background: "rgba(250,245,236,.12)", color: "#fff", border: "1px solid rgba(250,245,236,.3)", backdropFilter: "blur(4px)" }}>
                {L3(lang, "Book", "Забронировать", "Брондау")}
              </motion.a>
              <motion.span
                variants={{ hidden: reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }, visible: { opacity: 1, scale: 1, transition: { duration: reducedMotion ? 0.14 : 0.44, ease: MOTION.ease.enter } } }}
                className="text-xs font-bold px-3 py-2 rounded-full" style={{ background: "rgba(26,16,17,.55)", color: "#fff", border: "1px solid rgba(250,245,236,.14)" }}>
                <span style={{ color: "#7FBF63" }}>●</span> {t("today")} {t("until")} 01:00
              </motion.span>
            </motion.div>
          </div>
          {/* the feast photograph — mobile: below the text, faded top and bottom */}
          <motion.div className="sm:hidden relative pointer-events-none select-none -mx-5 mt-5 mb-[-2px] overflow-hidden"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 1.025 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: reducedMotion ? 0.14 : 0.78, delay: reducedMotion ? 0 : 0.28, ease: MOTION.ease.enter }}
            style={{ height: "min(62vw, 318px)" }}>
            <img src={HERO_IMAGE} alt="" aria-hidden="true"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
              className={`absolute inset-0 pointer-events-none select-none yusup-hero-photo ${ambientActive ? "" : "yusup-ambient-paused"}`}
              style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "right center", WebkitMaskImage: "linear-gradient(180deg, transparent 0%, rgba(0,0,0,.8) 11%, #000 25%, #000 88%, transparent 100%)", maskImage: "linear-gradient(180deg, transparent 0%, rgba(0,0,0,.8) 11%, #000 25%, #000 88%, transparent 100%)" }} />
          </motion.div>
        </div>
      </section>

      {/* menu */}
      <motion.section id="menu" className="max-w-5xl mx-auto px-4 py-10 scroll-mt-20"
        initial="hidden" whileInView="visible" viewport={{ once: true, amount: 0.04 }}
        variants={reducedMotion ? reducedSectionVariants : sectionVariants}>
        <motion.div variants={sectionChildMotion} className="flex items-end justify-between gap-4 flex-wrap mb-5">
          <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 700 }}>{t("menu")}</h2>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search")}
            className="rounded-full px-4 py-2 text-sm outline-none w-full sm:w-64"
            style={{ background: P.card, border: `1px solid ${P.line}` }} />
        </motion.div>
        <motion.div variants={sectionChildMotion} className="flex gap-2 overflow-x-auto pb-2 mb-5">
          {[{ id: "all", en: t("all"), ru: t("all") }, ...catList].map((c) => (
            <motion.button key={c.id} onClick={() => setActiveCat(c.id)} whileTap={{ scale: 0.97 }}
              className="whitespace-nowrap text-sm font-bold px-4 py-2 rounded-full"
              animate={{ backgroundColor: activeCat === c.id ? P.ink : P.card, color: activeCat === c.id ? "#fff" : P.txt, borderColor: activeCat === c.id ? P.ink : P.line }}
              transition={{ duration: reducedMotion ? 0.01 : MOTION.duration.micro }}
              style={{ border: "1px solid" }}>
              {c[lang] || c.en}
            </motion.button>
          ))}
        </motion.div>
        <LayoutGroup id="guest-menu">
          <motion.div variants={sectionChildMotion} className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <AnimatePresence mode="popLayout" initial={false}>
              {filtered.map((item, index) => (
                <DishCard key={item.id} item={item} lang={lang} t={t} index={index}
                  image={item.image || GALLERY_MENU_IMAGES[item.id]} cart={cart} setQty={setQty} isClosed={isClosed}
                  onAddFlight={runCartFlight} reducedMotion={reducedMotion} />
              ))}
              {filtered.length === 0 && (
                <motion.div key="empty-menu" layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="col-span-full text-center py-12" style={{ color: P.sub }}>
                  {L3(lang, "Nothing found", "Ничего не найдено", "Ештеңе табылмады")}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </LayoutGroup>
      </motion.section>

      {/* contacts / footer */}
      <motion.footer id="contacts" initial="hidden" whileInView="visible" viewport={{ once: true, amount: 0.2 }}
        variants={reducedMotion ? reducedSectionVariants : sectionVariants} style={{ background: P.ink }}>
        <div className="max-w-5xl mx-auto px-4 py-10 grid sm:grid-cols-3 gap-8">
          <div>
            <Logo h={52} tone="light" />
            <p className="text-xs mt-3" style={{ color: "rgba(255,255,255,.55)" }}>{t("footAbout")}</p>
          </div>
          <div className="text-sm" style={{ color: "rgba(255,255,255,.8)" }}>
            <div className="font-extrabold mb-2" style={{ color: "#fff" }}>{t("contacts")}</div>
            <div className="mb-1">{L3(lang, "Our location", "Наше местоположение", "Біздің орналасқан жеріміз")}: <a href="https://2gis.ru/geo/69.825314,42.434279" target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>2GIS</a></div>
            <div className="mb-1">{t("hours")}</div>
            <div><a href="tel:+77753798243" style={{ color: "inherit" }}>+7 775 379 82 43</a></div>
            <button onClick={openPrivacy} className="mt-3 text-xs font-bold underline p-0" style={{ background: "none", color: "rgba(255,255,255,.65)" }}>
              Политика конфиденциальности
            </button>
          </div>
          <div className="text-sm">
            <div className="font-extrabold mb-2" style={{ color: "#fff" }}>{L3(lang, "For the team", "Команде", "Команда үшін")}</div>
            <button onClick={goAdmin} className="font-bold text-sm px-4 py-2 rounded-full" style={{ background: "rgba(255,255,255,.1)", color: "#fff", border: "1px solid rgba(255,255,255,.2)" }}>
              {t("staff")} →
            </button>
          </div>
        </div>
      </motion.footer>

      {/* active order pill */}
      <AnimatePresence>
        {activeLive && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40">
            <motion.button whileTap={{ scale: 0.97 }} onClick={openCart}
              className="flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg font-bold text-sm"
              style={{ background: P.ink, color: "#fff" }}>
              {t("activeOrder")} №{activeLive.num} · <StatusPill s={activeLive.status} lang={lang} />
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* cart nudge pill — appears when items added but no active order */}
      <AnimatePresence>
        {cartCount > 0 && !activeLive && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40">
            <motion.button whileTap={{ scale: 0.97 }} onClick={openCart}
              className="flex items-center gap-3 px-5 py-3 rounded-full font-bold text-sm"
              style={{ background: P.teal, color: "#fff", boxShadow: "0 4px 24px rgba(116,36,39,.45)" }}>
              <span>{fmt(cartTotal)}</span>
              <span style={{ opacity: 0.85, fontWeight: 400 }}>·</span>
              <span style={{ opacity: 0.85, fontWeight: 400 }}>
                {lang === "en" ? "Tap to order →" : "Нажмите для заказа →"}
              </span>
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── admin: pieces ───────────────────────────────────────────────────── */
function PinGate({ onOk, lang, goSite }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);

  // Check if already logged in from a previous session — but validate the
  // token server-side first: tokens expire after 12h, and entering with a
  // dead one made every status update silently fail with 401.
  useEffect(() => {
    const existing = localStorage.getItem("aspan-token");
    if (!existing) return;
    let stale = false;
    (async () => {
      const valid = await apiCheckAuth();
      if (stale) return;
      if (valid) onOk();
      else localStorage.removeItem("aspan-token");
    })();
    return () => { stale = true; };
  }, [onOk]);

  const tryIn = async () => {
    if (!username.trim() || !password.trim()) return;
    setLoading(true);
    setErr(false);
    const token = await apiLogin(username, password);
    setLoading(false);
    if (token) onOk();
    else { setErr(true); setPassword(""); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: P.ink }}>
      <div className="w-full max-w-xs rounded-2xl p-6 text-center" style={{ background: P.ink2, border: "1px solid rgba(255,255,255,.1)" }}>
        <Logo h={60} className="mx-auto" tone="light" />
        <div className="text-xs mt-3 mb-4" style={{ color: "rgba(255,255,255,.5)" }}>
          {lang === "en" ? "Staff · Sign in to manage the café" : "Персонал · Войдите для управления кафе"}
        </div>
        <input
          type="text"
          value={username}
          onChange={(e) => { setUsername(e.target.value); setErr(false); }}
          onKeyDown={(e) => e.key === "Enter" && tryIn()}
          className="w-full text-center rounded-xl px-3 py-3 outline-none font-bold mb-2"
          style={{ background: "rgba(255,255,255,.08)", color: "#fff", border: `1px solid ${err ? P.red : "rgba(255,255,255,.15)"}` }}
          placeholder={lang === "en" ? "Username" : "Логин"}
          autoComplete="username"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setErr(false); }}
          onKeyDown={(e) => e.key === "Enter" && tryIn()}
          className="w-full text-center rounded-xl px-3 py-3 outline-none font-bold"
          style={{ background: "rgba(255,255,255,.08)", color: "#fff", border: `1px solid ${err ? P.red : "rgba(255,255,255,.15)"}` }}
          placeholder="••••••"
          autoComplete="current-password"
        />
        {err && <div className="text-xs font-bold mt-2" style={{ color: "#F09595" }}>
          {lang === "en" ? "Wrong username or password" : "Неверный логин или пароль"}
        </div>}
        <button onClick={tryIn} disabled={loading} className="w-full mt-4 py-3 rounded-xl font-extrabold"
          style={{ background: P.teal, color: "#fff", opacity: loading ? 0.6 : 1 }}>
          {loading ? "…" : (lang === "en" ? "Sign in" : "Войти")}
        </button>
        <button onClick={goSite} className="mt-3 text-xs font-bold" style={{ color: "rgba(255,255,255,.5)" }}>
          ← {lang === "en" ? "Back to the site" : "Назад на сайт"}
        </button>
      </div>
    </div>
  );
}

const PREP_PRESETS = [10, 15, 20, 30, 45, 60];

// Small dialog asking the waiter for the estimated preparation time (minutes)
// before a NEW order moves to PREPARING. Reuses the existing modal pattern.
function PrepTimeModal({ lang, onClose, onStart }) {
  const [mins, setMins] = useState(15);
  const [custom, setCustom] = useState("");
  const chosen = custom.trim() ? Number(custom.replace(/\D/g, "")) : mins;
  const ok = chosen > 0 && chosen <= 240;
  const L = (en, ru) => (lang === "en" ? en : ru);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog">
      <div className="absolute inset-0" style={{ background: "rgba(14,22,32,.55)" }} onClick={onClose} />
      <div className="relative w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5" style={{ background: P.bone }}>
        <div className="flex items-center justify-between mb-4">
          <div className="font-extrabold" style={{ fontFamily: FONT_DISPLAY, color: P.txt }}>
            {L("Estimated preparation time", "Примерное время приготовления")}
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full font-bold" style={{ background: P.card, border: `1px solid ${P.line}` }}>✕</button>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          {PREP_PRESETS.map((m) => {
            const active = !custom.trim() && mins === m;
            return (
              <button key={m} onClick={() => { setMins(m); setCustom(""); }}
                className="rounded-xl py-2.5 font-extrabold text-sm"
                style={{ background: active ? P.ink : P.card, color: active ? "#fff" : P.txt, border: `1px solid ${active ? P.ink : P.line}` }}>
                {m} {L("min", "мин")}
              </button>
            );
          })}
        </div>
        <Field label={L("Custom time, minutes", "Своё время, минут")} value={custom}
          onChange={(v) => setCustom(v.replace(/\D/g, ""))} ph="25" />
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl font-bold" style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}>
            {L("Cancel", "Отмена")}
          </button>
          <button disabled={!ok} onClick={() => onStart(chosen)} className="flex-1 py-3 rounded-xl font-extrabold"
            style={{ background: ok ? P.teal : P.line, color: ok ? "#fff" : P.sub }}>
            {L("Start Cooking", "Начать готовить")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Live countdown chip shown on the admin card while an order is PREPARING.
function PrepCountdownAdmin({ o, lang }) {
  const now = useNowTick(true, 15000);
  const left = prepMinutesLeft(o.estimated_ready_at, now);
  return (
    <div className="text-xs font-bold mt-2 rounded-lg px-3 py-2 inline-block" style={{ background: "#FBEFD9", color: "#8A5A12" }}>
      {left > 0
        ? (lang === "en" ? `Ready in approximately ${left} min` : `Готов примерно через ${left} мин`)
        : (lang === "en" ? "Time is up — mark it ready" : "Время вышло — отметьте готовность")}
      {o.preparation_minutes ? <span style={{ opacity: 0.7 }}> · {o.preparation_minutes} {lang === "en" ? "min total" : "мин всего"}</span> : null}
    </div>
  );
}

function OrderCard({ o, lang, onStatus, onEditItems, onAckCall, onBookingEnd }) {
  const [askPrep, setAskPrep] = useState(false);
  // Departure time for bookings — learned during the confirmation call.
  // Until saved, the slot blocks a default 3-hour span on the server.
  const bookingEndSaved = (o.booking && o.booking.endTime) || "";
  const [endT, setEndT] = useState(bookingEndSaved);
  const [endSaving, setEndSaving] = useState(false);
  const saveEnd = async () => {
    if (!endT || !onBookingEnd) return;
    setEndSaving(true);
    await onBookingEnd(o.id, endT);
    setEndSaving(false);
  };
  const next = {
    awaiting_confirmation: ["new", lang === "en" ? "Payment received ✓" : "Оплата получена ✓"],
    new: ["cooking", lang === "en" ? "Start cooking" : "В работу"],
    cooking: ["ready", lang === "en" ? "Mark ready" : "Готов"],
    ready: ["done", lang === "en" ? "Complete" : "Завершить"],
  }[o.status];
  // Dine-in orders move straight to work; timers are only useful for takeaway,
  // delivery and bookings.
  const advance = () => {
    if (o.status === "new" && o.type !== "table") setAskPrep(true);
    else onStatus(o.id, next[0]);
  };
  const scheduledFor = orderScheduledFor(o);
  const startCookAt = orderStartCookAt(o);
  const isSched = scheduledFor && scheduledFor > Date.now();
  // Part 3: a fresh booking needs a phone confirmation call before starting.
  const needsCall = o.type === "booking" && (o.status === "new" || o.status === "awaiting_confirmation") && !o.callConfirmed;
  return (
    <div className="rounded-2xl p-4" style={{ background: P.card, border: `1px solid ${isSched ? P.saff : P.line}` }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="font-extrabold" style={{ fontFamily: FONT_DISPLAY, fontSize: 15 }}>№{o.num}</div>
        <div className="flex items-center gap-1.5">
          {o.paymentMethod === "kaspi" && <Pill bg="#FDE3E0" fg="#C0281C">KASPI</Pill>}
          {isSched && <Pill bg="#FBEFD9" fg="#8A5A12">{timeOf(scheduledFor)}</Pill>}
          <StatusPill s={o.status} lang={lang} />
        </div>
      </div>
      {needsCall && (
        <div className="mt-2 rounded-xl p-3 text-sm" style={{ background: "#FAE5E3", border: "1px solid #E7A9A3" }}>
          <div className="font-extrabold" style={{ color: "#933A34" }}>{tr(lang, "callConfirm")}</div>
          <div className="text-xs mt-0.5" style={{ color: "#933A34" }}>{tr(lang, "callConfirmNote")}</div>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {o.phone && <a href={`tel:${o.phone}`} className="no-underline text-xs font-extrabold px-3 py-1.5 rounded-full" style={{ background: "#933A34", color: "#fff" }}>{o.phone}</a>}
            <button onClick={() => onAckCall && onAckCall(o.id)} className="text-xs font-bold px-3 py-1.5 rounded-full" style={{ background: "#fff", border: "1px solid #E7A9A3", color: "#933A34" }}>✓ {tr(lang, "callDone")}</button>
          </div>
        </div>
      )}
      {isSched && startCookAt && (
        <div className="mt-2 text-xs font-bold rounded-lg px-3 py-2 inline-block" style={{ background: "#FBEFD9", color: "#8A5A12" }}>
          {tr(lang, "schedFor")}: {timeOf(scheduledFor)} · {tr(lang, "startCookApprox")}{timeOf(startCookAt)}
        </div>
      )}
      <div className="text-xs mt-1" style={{ color: P.sub }}>
        {dateOf(o.ts)} · {timeOf(o.ts)} · {
          o.type === "booking" ? `${lang === "en" ? "Reservation" : "Бронь"}${o.phone ? " · " + o.phone : ""}`
          : o.type === "table" ? `${lang === "en" ? "Table" : "Стол"} ${o.table}`
          : o.type === "delivery" ? `${lang === "en" ? "Delivery" : "Доставка"}${o.name ? " · " + o.name : ""}${o.phone ? " · " + o.phone : ""}`
          : `${lang === "en" ? "Pickup" : "С собой"}${o.name ? " · " + o.name : ""}${o.phone ? " · " + o.phone : ""}`
        }
      </div>
      {o.type === "booking" && o.booking && (
        <div className="mt-2 rounded-xl p-3 text-sm" style={{ background: "#FBEFD9", border: `1px solid ${P.saff}` }}>
          <div className="font-extrabold" style={{ color: "#8A5A12" }}>{pickL(o.booking.roomName, lang)} · {lang === "en" ? "up to" : "до"} {o.booking.capacity}</div>
          <div className="mt-1 font-bold" style={{ color: P.txt }}>
            {o.booking.date} · {o.booking.time}
            {bookingEndSaved ? ` → ${bookingEndSaved}` : ` → ${lang === "en" ? "~3 h (default)" : "≈3 ч (по умолчанию)"}`}
            {o.booking.guests ? ` · ${o.booking.guests}` : ""}
          </div>
          <div style={{ color: P.txt }}>{o.booking.phone}</div>
          {/* The table frees up (and blocks earlier clients correctly) only
              when the real departure time is saved — ask during the call. */}
          {!["done", "cancelled"].includes(o.status) && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="text-xs font-bold" style={{ color: "#8A5A12" }}>{lang === "en" ? "Leaving at" : "Уйдут в"}:</span>
              <input type="time" value={endT} onChange={(e) => setEndT(e.target.value)}
                className="text-xs font-bold px-2 py-1.5 rounded-lg outline-none"
                style={{ background: "#fff", border: `1px solid ${P.saff}`, color: P.txt }} />
              <button onClick={saveEnd} disabled={!endT || endT === bookingEndSaved || endSaving}
                className="text-xs font-extrabold px-3 py-1.5 rounded-full"
                style={{ background: (!endT || endT === bookingEndSaved) ? P.line : P.teal, color: (!endT || endT === bookingEndSaved) ? P.sub : "#fff" }}>
                {endSaving ? "…" : `${lang === "en" ? "Save" : "Сохранить"}`}
              </button>
            </div>
          )}
          {(!o.items || o.items.length === 0) && (
            <div className="text-xs mt-1" style={{ color: "#8A5A12" }}>{tr(lang, "roomOnly")}</div>
          )}
        </div>
      )}
      {o.type === "delivery" && (
        <div className="mt-2 rounded-xl p-3 text-sm" style={{ background: "#F4EDE2", border: `1px solid ${P.line}` }}>
          {o.address && <div className="font-bold" style={{ color: P.txt }}>{o.address}</div>}
          {(o.lat != null && o.lng != null) ? (
            <div className="flex gap-2 mt-2 flex-wrap items-center">
              <a href={o.mapLink || `https://2gis.kz/geo/${o.lng},${o.lat}`} target="_blank" rel="noreferrer"
                className="no-underline text-xs font-extrabold px-3 py-1.5 rounded-full" style={{ background: "#1BA05A", color: "#fff" }}>
                {lang === "en" ? "Open in 2GIS" : "Открыть в 2ГИС"}
              </a>
              <a href={o.mapLinkGoogle || `https://maps.google.com/?q=${o.lat},${o.lng}`} target="_blank" rel="noreferrer"
                className="no-underline text-xs font-bold px-3 py-1.5 rounded-full" style={{ background: P.bone, border: `1px solid ${P.line}`, color: P.txt }}>
                Google
              </a>
              <span className="text-xs px-2 py-1.5" style={{ color: P.sub }}>{o.lat.toFixed(5)}, {o.lng.toFixed(5)}</span>
            </div>
          ) : (
            <div className="text-xs mt-1" style={{ color: P.sub }}>{lang === "en" ? "Address only — call the customer" : "Только адрес — позвоните клиенту"}</div>
          )}
        </div>
      )}
      <div className="mt-3 text-sm rounded-xl p-3" style={{ background: P.bone }}>
        {o.items.map((it, i) => (
          <div key={i} className="flex justify-between py-0.5">
            <span style={{ color: P.txt }}>{pickL(it.name, lang)} <b>× {it.qty}</b></span>
            <span className="font-bold">{fmt(it.price * it.qty)}</span>
          </div>
        ))}
        {o.items.length > 0 && (
          <div className="mt-2 pt-2" style={{ borderTop: `1px solid ${P.line}` }}>
            <OrderPriceBreakdown order={o} t={(k) => tr(lang, k)} lang={lang} />
          </div>
        )}
        {o.comment && <div className="text-xs mt-2 font-bold" style={{ color: P.tealD }}>{o.comment}</div>}
      </div>
      {o.type !== "table" && o.status === "cooking" && o.estimated_ready_at && <PrepCountdownAdmin o={o} lang={lang} />}
      {/* EDIT ITEMS BUTTON */}
      {(o.status === "new" || o.status === "cooking") && (
        <button onClick={onEditItems} className="text-xs font-bold px-3 py-2 rounded-full mb-3" style={{ background: P.bone, border: `1px solid ${P.line}`, color: P.txt }}>
          ✎ {lang === "en" ? "Edit items" : "Изменить состав"}
        </button>
      )}

      <div className="flex items-center justify-between mt-3">
        <div className="font-extrabold">{fmt(o.total)}{o.commissionFee ? <span className="text-xs ml-2" style={{ color: P.sub }}>({lang === "en" ? "fee" : "комиссия"} {fmt(o.commissionFee)})</span> : null}</div>
        <div className="flex gap-2">
          {["awaiting_confirmation", "new", "cooking"].includes(o.status) && (
            <button onClick={() => onStatus(o.id, "cancelled")} className="text-xs font-bold px-3 py-2 rounded-full" style={{ background: "#FAE5E3", color: "#933A34" }}>
              ✕ {lang === "en" ? "Cancel" : "Отмена"}
            </button>
          )}
          {next && (
            <button onClick={advance} className="text-xs font-extrabold px-4 py-2 rounded-full" style={{ background: P.teal, color: "#fff" }}>
              {next[1]} →
            </button>
          )}
        </div>
      </div>
      {askPrep && (
        <PrepTimeModal lang={lang} onClose={() => setAskPrep(false)}
          onStart={(m) => { setAskPrep(false); onStatus(o.id, "cooking", { preparation_minutes: m }); }} />
      )}
    </div>
  );
}

function ItemForm({ initial, onSave, onClose, lang }) {
  const [f, setF] = useState(initial || {
    id: "i" + Date.now(), cat: "mains", emoji: "🍛", price: 1000, tags: [], available: true, deliveryAvailable: true,
    name: { en: "", ru: "", kz: "" }, desc: { en: "", ru: "", kz: "" },
  });
  const [sizeEditorOpen, setSizeEditorOpen] = useState(() => !!(initial && initial.sizes && initial.sizes.length) || SIZE_FRIENDLY_CATS.has((initial && initial.cat) || "mains"));
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const setName = (l, v) => setF((p) => ({ ...p, name: { ...p.name, [l]: v } }));
  const setDesc = (l, v) => setF((p) => ({ ...p, desc: { ...p.desc, [l]: v } }));
  const toggleTag = (tg) => setF((p) => ({ ...p, tags: p.tags.includes(tg) ? p.tags.filter((x) => x !== tg) : [...p.tags, tg] }));
  const sizes = Array.isArray(f.sizes) ? f.sizes : [];
  const setSize = (idx, key, val) => setF((p) => {
    const next = [...(Array.isArray(p.sizes) ? p.sizes : [])];
    next[idx] = { ...next[idx], [key]: key === "price" ? Number(String(val).replace(/\D/g, "")) || 0 : val };
    return { ...p, sizes: next };
  });
  const addSize = () => setF((p) => ({ ...p, sizes: [...(Array.isArray(p.sizes) ? p.sizes : []), { label: "", price: Number(p.price) || 0 }] }));
  const removeSize = (idx) => setF((p) => ({ ...p, sizes: (Array.isArray(p.sizes) ? p.sizes : []).filter((_, i) => i !== idx) }));
  const cleanSizes = sizes.map((s) => ({ label: String(s.label || "").trim(), price: Number(s.price) || 0 })).filter((s) => s.label && s.price > 0);
  const hasSizes = sizeEditorOpen && cleanSizes.length > 0;
  const ok = f.name.en.trim() && f.name.ru.trim() && (hasSizes ? cleanSizes.length > 0 : Number(f.price) > 0);
  const L = (en, ru, kz) => (lang === "en" ? en : lang === "kz" ? (kz || ru) : ru);
  const saveDish = () => {
    const next = { ...f, price: hasSizes ? cleanSizes[0].price : Number(f.price) || 0, deliveryAvailable: f.deliveryAvailable !== false };
    if (hasSizes) next.sizes = cleanSizes;
    else delete next.sizes;
    onSave(next);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog">
      <div className="absolute inset-0" style={{ background: "rgba(14,22,32,.55)" }} onClick={onClose} />
      <div className="relative w-full sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl p-5" style={{ background: P.bone }}>
        <div className="flex items-center justify-between mb-4">
          <div className="font-extrabold" style={{ fontFamily: FONT_DISPLAY }}>{initial ? L("Edit dish", "Редактировать блюдо") : L("New dish", "Новое блюдо")}</div>
          <button onClick={onClose} className="w-9 h-9 rounded-full font-bold" style={{ background: P.card, border: `1px solid ${P.line}` }}>✕</button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label={L("Name (EN)", "Название (EN)", "Атауы (EN)")} value={f.name.en} onChange={(v) => setName("en", v)} ph="Flat white" />
          <Field label={L("Name (RU)", "Название (RU)", "Название (RU)")} value={f.name.ru} onChange={(v) => setName("ru", v)} ph="Флэт уайт" />
          <Field label={L("Name (KZ)", "Название (KZ)", "Атауы (KZ)")} value={f.name.kz || ""} onChange={(v) => setName("kz", v)} ph="Флэт уайт" />
        </div>
        <Field label={L("Description (EN)", "Описание (EN)", "Сипаттама (EN)")} value={f.desc.en} onChange={(v) => setDesc("en", v)} area />
        <Field label={L("Description (RU)", "Описание (RU)", "Описание (RU)")} value={f.desc.ru} onChange={(v) => setDesc("ru", v)} area />
        <Field label={L("Description (KZ)", "Описание (KZ)", "Сипаттама (KZ)")} value={f.desc.kz || ""} onChange={(v) => setDesc("kz", v)} area />
        <div className="grid grid-cols-2 gap-3">
          <Field label={L("Price, ₸", "Цена, ₸", "Бағасы, ₸")} value={String(f.price)} onChange={(v) => set("price", Number(v.replace(/\D/g, "")) || 0)} ph="1500" />
          <Field label={L("Emoji (photo stand-in)", "Эмодзи (вместо фото)", "Эмодзи (фото орнына)")} value={f.emoji} onChange={(v) => set("emoji", v)} ph="☕" />
        </div>
        <div className="mt-3">
          <div className="text-sm font-bold mb-1.5">{L("Category", "Категория")}</div>
          <div className="flex gap-2 flex-wrap">
            {CATS.map((c) => (
              <button key={c.id} onClick={() => { set("cat", c.id); if (SIZE_FRIENDLY_CATS.has(c.id)) setSizeEditorOpen(true); }} className="text-xs font-bold px-3 py-1.5 rounded-full"
                style={{ background: f.cat === c.id ? P.ink : P.card, color: f.cat === c.id ? "#fff" : P.txt, border: `1px solid ${f.cat === c.id ? P.ink : P.line}` }}>
                {c[lang]}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 rounded-xl p-3" style={{ background: P.card, border: `1px solid ${P.line}` }}>
          <div className="text-sm font-bold">{L("Delivery and pickup", "Доставка и с собой", "Жеткізу және өзімен алып кету")}</div>
          <div className="text-xs mt-1" style={{ color: P.sub }}>{L("Choose whether customers can order this dish for delivery or pickup.", "Выберите, можно ли заказать это блюдо с доставкой или с собой.", "Бұл тағамды жеткізуге немесе өзімен алып кетуге болатынын таңдаңыз.")}</div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            {[[true, L("Deliverable", "Можно заказать", "Тапсырыс беруге болады")], [false, L("Not deliverable", "Нельзя заказать", "Тапсырыс беруге болмайды")]].map(([value, label]) => {
              const selected = (f.deliveryAvailable !== false) === value;
              return <button key={String(value)} type="button" onClick={() => set("deliveryAvailable", value)} className="py-2.5 px-2 rounded-xl text-xs font-extrabold"
                style={{ background: selected ? (value ? "#5E8C4A" : "#C7514A") : P.bone, color: selected ? "#fff" : P.txt, border: `1px solid ${selected ? (value ? "#5E8C4A" : "#C7514A") : P.line}` }}>
                {label}
              </button>;
            })}
          </div>
        </div>
        <div className="mt-3 rounded-xl p-3" style={{ background: P.card, border: `1px solid ${P.line}` }}>
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-bold">{L("Portion / volume buttons", "Кнопки объёма / размера")}</div>
              <div className="text-xs" style={{ color: P.sub }}>{L("Use for tea, drinks, coffee, lemonades, etc.", "Для чая, напитков, кофе, лимонадов и похожих позиций.")}</div>
            </div>
            <button type="button" onClick={() => { setSizeEditorOpen((v) => !v); if (!sizeEditorOpen && sizes.length === 0) addSize(); }}
              className="text-xs font-bold px-3 py-1.5 rounded-full"
              style={{ background: sizeEditorOpen ? P.ink : P.bone, color: sizeEditorOpen ? "#fff" : P.txt, border: `1px solid ${sizeEditorOpen ? P.ink : P.line}` }}>
              {sizeEditorOpen ? L("On", "Вкл") : L("Add", "Добавить")}
            </button>
          </div>
          {sizeEditorOpen && (
            <div className="mt-3 flex flex-col gap-2">
              {sizes.length === 0 && (
                <button type="button" onClick={addSize} className="w-full py-2.5 rounded-xl font-bold text-sm" style={{ background: P.bone, color: P.txt }}>
                  + {L("Add size", "Добавить размер")}
                </button>
              )}
              {sizes.map((s, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
                  <Field label={L("Label", "Размер")} value={s.label || ""} onChange={(v) => setSize(i, "label", v)} ph="0.3л" />
                  <Field label={L("Price", "Цена")} value={String(s.price || "")} onChange={(v) => setSize(i, "price", v)} ph="990" />
                  <button type="button" onClick={() => removeSize(i)} className="h-[42px] px-3 rounded-xl font-bold" style={{ background: "#FAE5E3", color: "#933A34" }}>✕</button>
                </div>
              ))}
              {sizes.length > 0 && (
                <button type="button" onClick={addSize} className="w-full py-2.5 rounded-xl font-bold text-sm" style={{ background: P.bone, color: P.txt }}>
                  + {L("Add another size", "Добавить ещё размер")}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="mt-3">
          <div className="text-sm font-bold mb-1.5">{L("Badges", "Метки")}</div>
          <div className="flex gap-2 flex-wrap">
            {Object.keys(TAGS).map((tg) => (
              <button key={tg} onClick={() => toggleTag(tg)} className="text-xs font-bold px-3 py-1.5 rounded-full"
                style={{ background: f.tags.includes(tg) ? TAGS[tg].bg : P.card, color: f.tags.includes(tg) ? TAGS[tg].fg : P.sub, border: `1px solid ${P.line}` }}>
                {TAGS[tg][lang]}
              </button>
            ))}
          </div>
        </div>
        <button disabled={!ok} onClick={saveDish} className="w-full mt-5 py-3 rounded-xl font-extrabold"
          style={{ background: ok ? P.teal : P.line, color: ok ? "#fff" : P.sub }}>
          {L("Save", "Сохранить")}
        </button>
      </div>
    </div>
  );
}

/* ── admin panel ─────────────────────────────────────────────────────── */
/* ── Admin: Order Item Editor Modal ──────────────────────────────────── */
function OrderItemEditor({ order, menu, lang, onClose, onSave }) {
  const L = (en, ru) => (lang === "en" ? en : ru);
  const [items, setItems] = useState(order.items.map(i => ({...i})));

  const updateQty = (idx, delta) => {
    setItems(prev => prev.map((it, i) => i === idx ? {...it, qty: Math.max(0, it.qty + delta)} : it).filter(it => it.qty > 0));
  };

  const addItem = (menuItem) => {
    const exists = items.find(i => i.id === menuItem.id);
    if (exists) {
      updateQty(items.indexOf(exists), 1);
    } else {
      setItems(prev => [...prev, { id: menuItem.id, name: menuItem.name, price: menuItem.price, qty: 1 }]);
    }
  };

  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  // Fee only for waiter-served order types — must match the backend rule.
  const feeApplies = ["table", "booking"].includes(order.type);
  const fee = feeApplies ? serviceFeeOf(subtotal) : 0;
  // Editing dishes must never drop the delivery charge the client agreed to.
  const deliveryFee = Number(order.deliveryFee) > 0 ? Number(order.deliveryFee) : 0;
  const grandTotal = subtotal + fee + deliveryFee;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(14,22,32,.7)" }}>
      <div className="w-full max-w-md rounded-2xl p-6 max-h-[80vh] overflow-y-auto" style={{ background: P.card }}>
        <div className="flex justify-between mb-4">
          <div className="font-extrabold" style={{ fontFamily: FONT_DISPLAY }}>{L("Edit Order", "Редактировать")} №{order.num}</div>
          <button onClick={onClose} className="w-9 h-9 rounded-full font-bold" style={{ background: P.bone, border: `1px solid ${P.line}` }}>✕</button>
        </div>

        <div className="flex flex-col gap-2 mb-4">
          {items.map((it, idx) => (
            <div key={idx} className="flex items-center justify-between p-2 rounded-lg" style={{ background: P.bone }}>
              <div className="flex-1 text-sm font-bold truncate">{pickL(it.name, lang)}</div>
              <div className="flex items-center gap-2">
                <span className="text-sm" style={{color: P.sub}}>{fmt(it.price)}</span>
                <QtyControl qty={it.qty} onMinus={() => updateQty(idx, -1)} onPlus={() => updateQty(idx, 1)} />
              </div>
            </div>
          ))}
        </div>

        <div className="text-sm font-bold mb-2">{L("Add item", "Добавить позицию")}</div>
        <div className="grid grid-cols-2 gap-2 mb-4 max-h-40 overflow-y-auto p-1" style={{ border: `1px solid ${P.line}`, borderRadius: 12 }}>
          {menu.filter(m => m.available).map(m => (
            <button key={m.id} onClick={() => addItem(m)} className="text-left text-xs p-2 rounded-lg flex gap-2" style={{ background: P.bone }}>
              <span className="truncate">{pickL(m.name, lang)}</span>
            </button>
          ))}
        </div>

        <div className="p-3 rounded-lg mb-4" style={{ background: P.bone }}>
          <OrderPriceBreakdown order={{ subtotal, serviceFee: fee, deliveryFee, total: grandTotal }} t={(k) => tr(lang, k)} lang={lang} />
        </div>

        <button onClick={() => { onSave(order.id, items, grandTotal); onClose(); }} className="w-full py-3 rounded-xl font-extrabold" style={{ background: P.teal, color: "#fff" }}>
          {L("Save Changes", "Сохранить")}
        </button>
      </div>
    </div>
  );
}

function TableBusyEditor({ lang }) {
  const [tables, setTables] = useState(() => Array.from(
    { length: 30 },
    (_, index) => ({ number: index + 1, occupied: false }),
  ));
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(null);

  const load = useCallback(async () => {
    const data = await apiGetAdminTables();
    if (data) {
      setTables(data.tables);
      setFailed(false);
    } else {
      setFailed(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 20000);
    return () => clearInterval(timer);
  }, [load]);

  const toggle = async (table) => {
    if (saving !== null) return;
    setSaving(table.number);
    const result = await apiSetAdminTableOccupied(table.number, !table.occupied);
    setSaving(null);
    if (result === "auth") {
      localStorage.removeItem("aspan-token");
      window.location.reload();
      return;
    }
    if (result !== true) {
      alert(L3(
        lang,
        "Could not update the table. Try again.",
        "Не удалось обновить столик. Попробуйте ещё раз.",
        "Үстелді жаңарту мүмкін болмады. Қайталап көріңіз.",
      ));
      return;
    }
    setTables((current) => current.map((item) => (
      item.number === table.number
        ? { ...item, occupied: !item.occupied }
        : item
    )));
  };

  return (
    <section className="p-4 sm:p-5 rounded-2xl" style={{
      background: P.ink,
      border: "1px solid rgba(255,255,255,.10)",
      boxShadow: "0 14px 36px rgba(26,16,17,.16)",
    }}>
      <h2 className="font-extrabold mb-1" style={{ color: "#fff", fontSize: 18 }}>
        {L3(lang, "Table occupancy", "Занятость столиков", "Үстелдердің бос емес күйі")}
      </h2>
      <p className="text-xs sm:text-sm mb-4" style={{ color: "rgba(255,255,255,.72)" }}>
        {L3(
          lang,
          "Mark a table occupied when guests sit down. Tap it again when the table is free. Marks clear automatically after 14 hours.",
          "Отмечайте столик занятым, когда гости сели. Нажмите ещё раз, когда столик освободится. Отметки снимаются автоматически через 14 часов.",
          "Қонақтар отырғанда үстелді бос емес деп белгілеңіз. Босағанда қайта басыңыз. Белгілер 14 сағаттан кейін автоматты түрде алынады.",
        )}
      </p>
      {loading && <div className="text-sm" style={{ color: "rgba(255,255,255,.72)" }}>...</div>}
      {failed && !loading && (
        <div role="alert" className="text-sm font-bold mb-3" style={{ color: "#FFB4AC" }}>
          {L3(lang, "Could not load tables.", "Не удалось загрузить столики.", "Үстелдерді жүктеу мүмкін болмады.")}
        </div>
      )}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {tables.map((table) => (
          <button key={table.number} type="button" onClick={() => toggle(table)}
            disabled={loading || failed || saving !== null}
            aria-pressed={table.occupied}
            className="py-2.5 font-extrabold text-sm flex flex-col items-center leading-tight rounded-xl"
            style={{
              minHeight: 58,
              background: table.occupied ? P.red : "#343A42",
              color: "#fff",
              border: table.occupied
                ? "1px solid #E08C77"
                : "1px solid rgba(255,255,255,.18)",
              opacity: loading || failed || saving === table.number ? 0.58 : 1,
            }}>
            <span style={{ fontSize: 18 }}>{table.number}</span>
            <span style={{ fontSize: 10 }}>
              {loading || failed
                ? "..."
                : table.occupied
                ? L3(lang, "occupied", "занят", "бос емес")
                : L3(lang, "free", "свободен", "бос")}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function LoyaltyAdmin({ lang }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const L = (en, ru, kz) => L3(lang, en, ru, kz);
  const load = useCallback(async () => {
    setLoading(true);
    const data = await apiGetAdminLoyalty();
    setReport(data);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const accounts = (report?.accounts || []).filter((account) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return account.phone.includes(needle.replace(/\D/g, ""))
      || String(account.maskedCode || "").toLowerCase().includes(needle);
  });
  const submitAdjustment = async () => {
    const value = Number(amount);
    if (!editing || !Number.isInteger(value) || value === 0) return;
    setSaving(true);
    const result = await apiAdjustLoyalty(editing.id, value, note);
    setSaving(false);
    if (!result) {
      alert(L("The adjustment was not saved.", "Корректировка не сохранена.", "Түзету сақталмады."));
      return;
    }
    setEditing(null);
    setAmount("");
    setNote("");
    await load();
  };
  if (loading && !report) {
    return <div className="py-16 text-center text-sm font-bold" style={{ color: P.sub }}>{L("Loading bonuses...", "Загружаем бонусы...", "Бонустар жүктелуде...")}</div>;
  }
  if (!report) {
    return (
      <div className="py-16 text-center">
        <div className="font-bold" style={{ color: P.red }}>{L("Could not load bonuses.", "Не удалось загрузить бонусы.", "Бонустарды жүктеу мүмкін болмады.")}</div>
        <button type="button" onClick={load} className="mt-4 px-4 py-2 rounded-full font-bold" style={{ background: P.ink, color: "#fff" }}>
          {L("Retry", "Повторить", "Қайталау")}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h2 className="font-extrabold" style={{ fontFamily: FONT_DISPLAY, fontSize: 24, color: P.txt }}>
            {L("Customer bonuses", "Бонусы клиентов", "Клиент бонустары")}
          </h2>
          <div className="text-sm mt-1" style={{ color: P.sub }}>
            {report.settings.earnPercent}% · {L("payment limit", "лимит оплаты", "төлем шегі")} {report.settings.redeemPercent}% · {report.settings.expiryDays} {L("days", "дней", "күн")}
          </div>
        </div>
        <button type="button" onClick={load} disabled={loading} title={L("Refresh", "Обновить", "Жаңарту")}
          className="w-10 h-10 rounded-full font-extrabold" style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}>
          ↻
        </button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {[
          [L("Customers", "Клиенты", "Клиенттер"), report.summary.customers],
          [L("Available", "Доступно", "Қолжетімді"), fmt(report.summary.available)],
          [L("Issued", "Начислено", "Есептелді"), fmt(report.summary.issued)],
          [L("Redeemed", "Списано", "Жұмсалды"), fmt(report.summary.redeemed)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg p-4" style={{ background: P.card, border: `1px solid ${P.line}` }}>
            <div className="text-xs font-bold" style={{ color: P.sub }}>{label}</div>
            <div className="font-extrabold mt-1" style={{ color: P.txt, fontSize: 20 }}>{value}</div>
          </div>
        ))}
      </div>
      <div className="mb-3">
        <input value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={L("Search by phone or masked ID", "Поиск по телефону или маске ID", "Телефон немесе ID маскасы бойынша іздеу")}
          className="w-full rounded-lg px-4 py-3 text-sm outline-none"
          style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }} />
      </div>
      <div style={{ background: P.card, border: `1px solid ${P.line}`, borderRadius: 8, overflow: "hidden" }}>
        {accounts.length === 0 && (
          <div className="p-8 text-center text-sm" style={{ color: P.sub }}>{L("No customers found.", "Клиенты не найдены.", "Клиенттер табылмады.")}</div>
        )}
        {accounts.map((account) => (
          <div key={account.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3"
            style={{ borderTop: `1px solid ${P.line}` }}>
            <div className="flex-1 min-w-0">
              <div className="font-extrabold" style={{ color: P.txt }}>+{account.phone}</div>
              <div className="text-xs font-bold mt-1" style={{ color: P.tealD }}>{account.maskedCode}</div>
              <div className="text-xs mt-1" style={{ color: P.sub }}>
                {L("Available", "Доступно", "Қолжетімді")}: {fmt(account.balance)} · {L("Issued", "Начислено", "Есептелді")}: {fmt(account.issued)}
              </div>
            </div>
            <div>
              <button type="button" onClick={() => { setEditing(account); setAmount(""); setNote(""); }}
                className="px-3 py-2 rounded-lg text-xs font-bold" style={{ background: P.ink, color: "#fff" }}>
                {L("Adjust", "Изменить", "Өзгерту")}
              </button>
            </div>
          </div>
        ))}
      </div>
      <AnimatePresence>
        {editing && (
          <motion.div className="fixed inset-0 z-[80] flex items-center justify-center p-4"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ background: "rgba(14,22,32,.58)" }}>
            <motion.div className="w-full max-w-md rounded-lg p-5" initial={{ y: 10 }} animate={{ y: 0 }}
              style={{ background: P.card }}>
              <div className="font-extrabold text-lg" style={{ color: P.txt }}>+{editing.phone}</div>
              <div className="text-xs mt-1 mb-4" style={{ color: P.sub }}>
                {L("Use a positive number to add and a negative number to remove.", "Плюс начисляет, минус списывает.", "Оң сан қосады, теріс сан шегереді.")}
              </div>
              <Field label={L("Amount", "Сумма", "Сома")} value={amount} onChange={setAmount} ph="+500 / -500" />
              <div className="mt-3"><Field label={L("Audit note", "Причина", "Себеп")} value={note} onChange={setNote} ph={L("Required for staff records", "Для истории операций", "Операциялар тарихы үшін")} /></div>
              <div className="flex gap-2 mt-5">
                <button type="button" onClick={() => setEditing(null)} className="flex-1 py-3 rounded-lg font-bold"
                  style={{ background: P.bone, border: `1px solid ${P.line}`, color: P.txt }}>{L("Cancel", "Отмена", "Бас тарту")}</button>
                <button type="button" onClick={submitAdjustment} disabled={saving || !note.trim() || !Number.isInteger(Number(amount)) || Number(amount) === 0}
                  className="flex-1 py-3 rounded-lg font-extrabold"
                  style={{ background: P.teal, color: "#fff", opacity: saving ? 0.6 : 1 }}>{saving ? "..." : L("Save", "Сохранить", "Сақтау")}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function AdminPanel({ lang, setLang, menu, saveMenu, orders, updateStatus, ackCall, setBookingEnd, refreshOrders, goSite, cafeInfo, saveCafeStatus }) {
  const [tab, setTab] = useState("orders");
  const [filter, setFilter] = useState("type:table");
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [superPin, setSuperPin] = useState("");
  const [isSuper, setIsSuper] = useState(false);
  const [settling, setSettling] = useState(false);
  const [editingOrderItems, setEditingOrderItems] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [salesHistory, setSalesHistory] = useState(EMPTY_SALES_HISTORY);
  const [historyPeriod, setHistoryPeriod] = useState("weeks");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  // Fresh orders staff haven't acknowledged yet — drives a repeating alarm
  // and a persistent banner on every admin tab.
  const [unackedOrders, setUnackedOrders] = useState([]);
  const notifiedOrderIds = React.useRef(new Set());
  const didInitOrderNotice = React.useRef(false);
  const audioCtxRef = React.useRef(null);
  const L = (en, ru) => (lang === "en" ? en : ru);
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const defaultHours = Object.fromEntries(days.map((day) => [day, "08:00-01:00"]));
  const [hoursDraft, setHoursDraft] = useState(() => ({ ...defaultHours, ...(cafeInfo.hours || {}) }));
  const hoursKey = JSON.stringify(cafeInfo.hours || null);
  useEffect(() => {
    setHoursDraft({ ...defaultHours, ...(cafeInfo.hours || {}) });
  }, [hoursKey]);
  const saveHours = () => {
    const valid = days.every((day) => /^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/.test(hoursDraft[day] || ""));
    if (!valid) {
      alert(L("Use HH:MM-HH:MM for every day, for example 08:00-01:00.",
              "Для каждого дня используйте ЧЧ:ММ-ЧЧ:ММ, например 08:00-01:00."));
      return;
    }
    saveCafeStatus({ ...cafeInfo, hours: hoursDraft });
  };
  // Delivery zone editor. Edited locally and saved explicitly so typing is
  // not clobbered by the settings poll.
  const [zoneDraft, setZoneDraft] = useState(() =>
    deliveryCfgOf(cafeInfo).zones.map((zone) => ({
      km: String(zone.km),
      fee: String(zone.fee),
    })));
  const deliveryKey = JSON.stringify((cafeInfo && cafeInfo.delivery) || null);
  useEffect(() => {
    setZoneDraft(deliveryCfgOf(cafeInfo).zones.map((zone) => ({
      km: String(zone.km),
      fee: String(zone.fee),
    })));
  }, [deliveryKey]);
  const updateZoneDraft = (index, field, value) => {
    setZoneDraft((current) => current.map((zone, i) => (
      i === index ? { ...zone, [field]: value } : zone
    )));
  };
  const addZone = () => {
    if (zoneDraft.length >= MAX_DELIVERY_ZONES) return;
    const last = zoneDraft[zoneDraft.length - 1] || { km: "0", fee: "0" };
    const nextKm = Math.round(((Number(last.km) || 0) + 2) * 10) / 10;
    const nextFee = Math.max(0, (Number(last.fee) || 0) + 200);
    setZoneDraft((current) => [
      ...current,
      { km: String(nextKm), fee: String(nextFee) },
    ]);
  };
  const removeZone = (index) => {
    if (zoneDraft.length <= 1) return;
    setZoneDraft((current) => current.filter((_, i) => i !== index));
  };
  const saveZones = () => {
    const zones = zoneDraft.map((zone) => ({
      km: Number(zone.km),
      fee: Number(zone.fee),
    }));
    const valid = zones.length >= 1 && zones.length <= MAX_DELIVERY_ZONES
      && zones.every((zone) => Number.isFinite(zone.km) && zone.km > 0 && zone.km <= 100
        && Number.isInteger(zone.fee) && zone.fee >= 0 && zone.fee <= 100000)
      && zones.every((zone, i) => i === 0 || zones[i - 1].km < zone.km);
    if (!valid) {
      alert(L(
        "Use increasing radii from 0.1 to 100 km and whole-number prices from 0 to 100,000 ₸.",
        "Укажите возрастающие радиусы от 0,1 до 100 км и целые цены от 0 до 100 000 ₸.",
      ));
      return;
    }
    saveCafeStatus({ ...cafeInfo, delivery: { zones } });
  };
  const typeTabs = [
    ["type:table", "В зале", "table"],
    ["type:pickup", "С собой", "pickup"],
    ["type:delivery", "Доставка", "delivery"],
  ];
  const statusTabs = [
    ["awaiting_confirmation", STATUS.awaiting_confirmation[lang]],
    ["new", STATUS.new[lang]],
    ["cooking", STATUS.cooking[lang]],
    ["ready", STATUS.ready[lang]],
    ["done", STATUS.done[lang]],
    ["cancelled", STATUS.cancelled[lang]],
    ["all", L("All", "Все")],
  ];
  const badgeCounts = useMemo(() => {
    const counts = { table: 0, pickup: 0, delivery: 0 };
    orders.forEach((o) => {
      if (Object.prototype.hasOwnProperty.call(counts, o.type) && ["awaiting_confirmation", "new"].includes(o.status)) {
        counts[o.type] += 1;
      }
    });
    return counts;
  }, [orders]);
  const playOrderSound = useCallback(() => {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = audioCtxRef.current || new AudioContext();
      audioCtxRef.current = ctx;
      if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime;
      [0, 0.16].forEach((offset, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(i ? 1046 : 784, now + offset);
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.13);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.14);
      });
    } catch (e) {}
  }, []);
  useEffect(() => {
    const unlock = () => {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = audioCtxRef.current || new AudioContext();
        audioCtxRef.current = ctx;
        if (ctx.state === "suspended") ctx.resume();
      } catch (e) {}
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
  useEffect(() => {
    const incoming = orders.filter((o) => ["awaiting_confirmation", "new"].includes(o.status));
    if (!didInitOrderNotice.current) {
      incoming.forEach((o) => notifiedOrderIds.current.add(o.id));
      didInitOrderNotice.current = true;
      return;
    }
    const fresh = incoming.filter((o) => !notifiedOrderIds.current.has(o.id));
    fresh.forEach((o) => notifiedOrderIds.current.add(o.id));
    // An order the staff already acted on (moved to cooking / cancelled)
    // stops alarming by itself; fresh ones join the alarm queue.
    const stillIncoming = new Set(incoming.map((o) => o.id));
    setUnackedOrders((prev) => {
      const kept = prev.filter((p) => stillIncoming.has(p.id));
      if (!fresh.length && kept.length === prev.length) return prev;
      return [...kept, ...fresh.map((o) => ({ id: o.id, num: o.num, type: o.type }))];
    });
    if (fresh.length) playOrderSound();
  }, [orders, playOrderSound]);
  // Keep ringing until every new order is acknowledged or handled.
  useEffect(() => {
    if (!unackedOrders.length) return;
    const t = setInterval(playOrderSound, 15000);
    return () => clearInterval(t);
  }, [unackedOrders.length > 0, playOrderSound]);
  // Manual refresh with visible feedback (the plain button gave no signal,
  // so it felt broken even though it worked).
  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await refreshOrders(); } finally {
      // keep the spinner visible briefly so the click clearly registers
      setTimeout(() => setRefreshing(false), 400);
    }
  };

const handleSaveItems = async (id, items, total) => {
  await apiEditOrderItems(id, items, total);
  refreshOrders();
  loadLedger();
};

  const loadLedger = useCallback(async () => { const d = await apiGetLedger(); if (d) setLedger(d); }, []);
  const loadSalesHistory = useCallback(async () => {
    setHistoryLoading(true);
    const data = await apiGetSalesHistory();
    if (data) {
      setSalesHistory(data);
      setHistoryError(false);
    } else {
      setHistoryError(true);
    }
    setHistoryLoading(false);
  }, []);

  useEffect(() => {
    if (tab === "finance") { loadLedger(); }
    // Orders poll on EVERY tab — the new-order alarm must fire even while
    // staff sit on the menu or finance screens.
    refreshOrders();
    const t = setInterval(refreshOrders, 20000);
    return () => clearInterval(t);
  }, [tab, refreshOrders, loadLedger]);

  useEffect(() => {
    if (tab === "stats") loadSalesHistory();
  }, [tab, loadSalesHistory]);

  const settle = async () => {
    setSettling(true);
    await apiSettleLedger(`Payout ${new Date().toLocaleDateString("ru-RU")}`);
    await loadLedger();
    setSettling(false);
  };

  const typeFilter = filter.startsWith("type:") ? filter.slice(5) : null;
  const shown = orders.filter((o) =>
    typeFilter ? o.type === typeFilter && !["done", "cancelled"].includes(o.status) :
    filter === "all" ? true : o.status === filter);
  const menuCats = useMemo(() => orderedCats(menu), [menu]);

  // Keep future pre-orders separated on broad/category queues, even though the
  // old "active" tab was replaced by order-type filters.
  const splitQueue = typeFilter || filter === "all";
  const nowTick = useNowTick(tab === "orders" && !!splitQueue, 30000);
  const scheduledOrders = splitQueue ? shown.filter((o) => isFutureScheduled(o, nowTick)) : [];
  const liveOrders = splitQueue ? shown.filter((o) => !isFutureScheduled(o, nowTick)) : shown;

  const salesTotals = useMemo(() => salesTotalsForPeriods(orders), [orders]);
  const top = useMemo(() => {
    const m = {};
    orders.filter((o) => o.status !== "cancelled").forEach((o) => o.items.forEach((it) => {
      const k = pickL(it.name, lang) || "?";
      m[k] = (m[k] || 0) + it.qty;
    }));
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [orders, lang]);
  const maxTop = top.length ? top[0][1] : 1;

  return (
    <div style={{ background: P.bone, minHeight: "100vh", color: P.txt }}>
      <header className="sticky top-0 z-40" style={{ background: P.ink }}>
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Logo h={34} tone="light" />
          <span className="font-extrabold text-sm" style={{ fontFamily: FONT_DISPLAY, color: "#fff" }}>
            · {L("Admin", "Админка")}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setLang(nextLang(lang))} className="text-xs font-extrabold px-3 py-1.5 rounded-full" style={{ background: "rgba(255,255,255,.12)", color: "#fff" }}>
              {langCode(lang)}
            </button>
            <button onClick={goSite} className="text-xs font-bold px-3 py-1.5 rounded-full" style={{ background: "rgba(255,255,255,.12)", color: "#fff" }}>
              ← {L("Site", "Сайт")}
            </button>
          </div>
        </div>
        <nav aria-label={L("Admin sections", "Разделы админки")}
          className="max-w-5xl mx-auto px-4 pb-3 grid grid-cols-3 gap-2 md:flex md:items-center">
          {[["orders", L("Orders", "Заказы")], ["menu", L("Menu", "Меню")], ["tables", L("Tables", "Столики")], ["loyalty", L("Bonuses", "Бонусы")], ["stats", L("Analytics", "Аналитика")], ["finance", L("Finance", "Финансы")], ["schedule", L("Schedule", "График")]].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} className="relative min-w-0 text-xs md:text-sm font-bold px-2 md:px-4 py-2 rounded-full whitespace-nowrap"
              style={{ background: tab === id ? P.teal : "rgba(255,255,255,.08)", color: "#fff" }}>
              {label}
            </button>
            ))}
            <button
             onClick={() => { localStorage.removeItem("aspan-token"); window.location.reload(); }}
             className="col-span-3 md:col-auto md:ml-auto text-xs font-bold px-3 py-2 md:py-1.5 rounded-full"
             style={{ background: "rgba(255,255,255,.12)", color: "#fff" }}>
          {L("Logout", "Выйти")}
            </button>
        </nav>
      </header>

      {unackedOrders.length > 0 && (
        <div className="sticky z-40" style={{ top: 0 }}>
          <div className="px-4 py-3 flex items-center gap-3 flex-wrap"
            style={{ background: "#C0392B", color: "#fff", animation: "pulse 1.2s ease-in-out infinite" }}>
            <span className="font-extrabold text-sm">
              {unackedOrders.length === 1
                ? `${L("New order", "Новый заказ")} №${unackedOrders[0].num}`
                : `${L("New orders", "Новых заказов")}: ${unackedOrders.length}`}
            </span>
            <button onClick={() => { setTab("orders"); setFilter("all"); }}
              className="text-xs font-extrabold px-3 py-1.5 rounded-full"
              style={{ background: "rgba(255,255,255,.2)", color: "#fff" }}>
              {L("Show", "Показать")}
            </button>
            <button onClick={() => setUnackedOrders([])}
              className="ml-auto text-xs font-extrabold px-4 py-1.5 rounded-full"
              style={{ background: "#fff", color: "#C0392B" }}>
              ✓ {L("Got it", "Принято")}
            </button>
          </div>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 py-6">
        {tab === "loyalty" && <LoyaltyAdmin lang={lang} />}
        {tab === "orders" && (
          <>
            <div className="flex gap-2 flex-wrap mb-4 items-center">
              {typeTabs.map(([v, label, type]) => (
                <button key={v} onClick={() => setFilter(v)} className="text-xs font-bold px-3 py-1.5 rounded-full"
                  style={{ background: filter === v ? P.ink : P.card, color: filter === v ? "#fff" : P.txt, border: `1px solid ${filter === v ? P.ink : P.line}` }}>
                  {label}
                  {badgeCounts[type] > 0 && (
                    <span className="ml-1.5 inline-flex items-center justify-center rounded-full text-[10px] font-extrabold"
                      style={{ minWidth: 18, height: 18, padding: "0 5px", background: P.red, color: "#fff" }}>
                      {badgeCounts[type]}
                    </span>
                  )}
                </button>
              ))}
              {statusTabs.map(([v, label]) => (
                <button key={v} onClick={() => setFilter(v)} className="text-xs font-bold px-3 py-1.5 rounded-full"
                  style={{ background: filter === v ? P.ink : P.card, color: filter === v ? "#fff" : P.txt, border: `1px solid ${filter === v ? P.ink : P.line}` }}>
                  {label}
                </button>
              ))}
              <button onClick={doRefresh} disabled={refreshing} className="ml-auto text-xs font-bold px-3 py-1.5 rounded-full inline-flex items-center gap-1.5"
                style={{ background: refreshing ? P.teal : P.card, color: refreshing ? "#fff" : P.txt, border: `1px solid ${refreshing ? P.teal : P.line}`, opacity: refreshing ? 0.85 : 1 }}>
                <span style={{ display: "inline-block", animation: refreshing ? "spin 0.7s linear infinite" : "none" }}>↻</span>
                {refreshing ? L("Refreshing…", "Обновляем…") : L("Refresh", "Обновить")}
              </button>
            </div>
            {shown.length === 0 ? (
              <div className="text-center py-16" style={{ color: P.sub }}>
                <div className="font-bold mt-2">{L("No orders here yet", "Заказов пока нет")}</div>
                <div className="text-xs mt-1">{L("New orders from the site appear automatically.", "Новые заказы с сайта появятся автоматически.")}</div>
              </div>
            ) : (
              <>
                {splitQueue && scheduledOrders.length > 0 && (
                  <div className="mb-6">
                    <div className="text-sm font-extrabold mb-3" style={{ color: "#8A5A12" }}>{tr(lang, "schedSection")} · {scheduledOrders.length}</div>
                    <div className="grid sm:grid-cols-2 gap-4">
                      {scheduledOrders.map((o) => (
                        <OrderCard key={o.id} o={o} lang={lang} onStatus={updateStatus} onAckCall={ackCall} onBookingEnd={setBookingEnd} onEditItems={() => setEditingOrderItems(o)} />
                      ))}
                    </div>
                  </div>
                )}
                {splitQueue && scheduledOrders.length > 0 && liveOrders.length > 0 && (
                  <div className="text-sm font-extrabold mb-3" style={{ color: P.txt }}>{tr(lang, "activeSection")} · {liveOrders.length}</div>
                )}
                <div className="grid sm:grid-cols-2 gap-4">
                  {liveOrders.map((o) => (
                    <OrderCard key={o.id} o={o} lang={lang} onStatus={updateStatus} onAckCall={ackCall} onBookingEnd={setBookingEnd} onEditItems={() => setEditingOrderItems(o)} />
                  ))}
                  {editingOrderItems && (
                    <OrderItemEditor
                      order={editingOrderItems}
                      menu={menu}
                      lang={lang}
                      onClose={() => setEditingOrderItems(null)}
                      onSave={handleSaveItems}
                    />
                  )}
                </div>
              </>
            )}
          </>
        )}

        {tab === "menu" && (
          <>
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-bold" style={{ color: P.sub }}>
                {menu.length} {L("dishes", "позиций")} · {menu.filter((m) => !m.available).length} {L("in stop list", "в стоп-листе")}
              </div>
              <button onClick={() => setAdding(true)} className="text-sm font-extrabold px-4 py-2 rounded-full" style={{ background: P.teal, color: "#fff" }}>
                + {L("Add dish", "Добавить блюдо")}
              </button>
            </div>
            {menuCats.map((c, catIdx) => {
              const items = menu.filter((m) => m.cat === c.id);
              if (!items.length) return null;
              const visibleCatCount = menuCats.filter((x) => menu.some((m) => m.cat === x.id)).length;
              return (
                <div key={c.id} className="mb-6">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="font-extrabold" style={{ fontFamily: FONT_DISPLAY, fontSize: 14 }}>{c[lang]}</div>
                    <div className="flex gap-1">
                      <button type="button" disabled={catIdx === 0} onClick={() => saveMenu(reorderCategory(menu, c.id, -1))}
                        className="w-8 h-8 rounded-full font-extrabold"
                        style={{ background: P.card, color: P.txt, border: `1px solid ${P.line}`, opacity: catIdx === 0 ? 0.35 : 1 }}>↑</button>
                      <button type="button" disabled={catIdx === visibleCatCount - 1} onClick={() => saveMenu(reorderCategory(menu, c.id, 1))}
                        className="w-8 h-8 rounded-full font-extrabold"
                        style={{ background: P.card, color: P.txt, border: `1px solid ${P.line}`, opacity: catIdx === visibleCatCount - 1 ? 0.35 : 1 }}>↓</button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    {items.map((m, itemIdx) => (
                      <div key={m.id} className="flex items-center gap-3 rounded-xl p-3" style={{ background: P.card, border: `1px solid ${P.line}`, opacity: m.available ? 1 : 0.6 }}>
                        <div className="relative w-14 h-14 rounded-lg overflow-hidden flex items-center justify-center flex-shrink-0 cursor-pointer group"
                          style={{ background: c.tint }}
                          onClick={() => {
                            const inp = document.createElement("input");
                            inp.type = "file";
                            inp.accept = "image/jpeg,image/png,image/webp";
                            inp.onchange = async (e) => {
                              const file = e.target.files[0];
                              if (!file) return;
                              try {
                                const image = await menuImageFromFile(file);
                                saveMenu(menu.map((x) => x.id === m.id ? { ...x, image } : x));
                              } catch (err) {
                                alert(L("Please upload a JPG, PNG, or WebP image up to 6 MB.", "Загрузите JPG, PNG или WebP до 6 МБ."));
                              }
                            };
                            inp.click();
                          }}>
                          {m.image ? (
                            <img src={m.image} alt={pickL(m.name, lang)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          ) : (
                            <span style={{ fontSize: 24 }}>{m.emoji}</span>
                          )}
                          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: "rgba(0,0,0,.45)" }}>
                            <span className="text-[10px] font-extrabold uppercase tracking-wide" style={{ color: "#fff" }}>{L("Photo", "Фото")}</span>
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-bold text-sm truncate">{pickL(m.name, lang)}</div>
                          <div className="text-xs" style={{ color: P.sub }}>
                            {Array.isArray(m.sizes) && m.sizes.length ? m.sizes.map((s) => `${s.label} ${fmt(s.price)}`).join(" · ") : fmt(m.price)}
                            {m.tags.length ? " · " + m.tags.map((tg) => TAGS[tg][lang]).join(", ") : ""}
                          </div>
                          {m.image && (
                            <button onClick={() => saveMenu(menu.map((x) => x.id === m.id ? { ...x, image: null } : x))}
                              className="text-xs mt-0.5" style={{ color: P.red }}>
                              {L("Remove photo", "Удалить фото")}
                            </button>
                          )}
                        </div>
                        <div className="flex flex-col gap-1">
                          <button type="button" disabled={itemIdx === 0} onClick={() => saveMenu(moveMenuItem(menu, m.id, -1))}
                            className="w-8 h-7 rounded-lg font-extrabold text-xs"
                            style={{ background: P.bone, color: P.txt, border: `1px solid ${P.line}`, opacity: itemIdx === 0 ? 0.35 : 1 }}>↑</button>
                          <button type="button" disabled={itemIdx === items.length - 1} onClick={() => saveMenu(moveMenuItem(menu, m.id, 1))}
                            className="w-8 h-7 rounded-lg font-extrabold text-xs"
                            style={{ background: P.bone, color: P.txt, border: `1px solid ${P.line}`, opacity: itemIdx === items.length - 1 ? 0.35 : 1 }}>↓</button>
                        </div>
                        <button onClick={() => saveMenu(menu.map((x) => x.id === m.id ? { ...x, available: !x.available } : x))}
                          className="text-xs font-bold px-3 py-1.5 rounded-full"
                          style={{ background: m.available ? "#E9F1DF" : "#FAE5E3", color: m.available ? "#3F7A2E" : "#933A34" }}>
                          {m.available ? L("On menu", "В меню") : L("Stopped", "Стоп")}
                        </button>
                        <button onClick={() => setEditing(m)} className="text-xs font-bold px-3 py-1.5 rounded-full" style={{ background: P.bone, border: `1px solid ${P.line}` }}>
                          {L("Edit", "Изменить")}
                        </button>
                        {confirmDel === m.id ? (
                          <button onClick={() => { saveMenu(menu.filter((x) => x.id !== m.id)); setConfirmDel(null); }}
                            className="text-xs font-extrabold px-3 py-1.5 rounded-full" style={{ background: P.red, color: "#fff" }}>
                            {L("Sure?", "Точно?")}
                          </button>
                        ) : (
                          <button onClick={() => { setConfirmDel(m.id); setTimeout(() => setConfirmDel(null), 2500); }}
                            className="text-xs font-bold px-3 py-1.5 rounded-full" style={{ background: "#FAE5E3", color: "#933A34" }}>
                            {L("Delete", "Удалить")}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {tab === "tables" && <TableBusyEditor lang={lang} />}

        {tab === "stats" && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
              {[[L("Orders today", "Заказов сегодня"), String(salesTotals.todayOrders)],
                [L("Revenue today", "Выручка сегодня"), fmt(salesTotals.todayRevenue)],
                [L("Average check today", "Средний чек сегодня"), fmt(salesTotals.averageToday)],
                [L("Revenue this week", "Выручка за неделю"), fmt(salesTotals.weekRevenue)],
                [L("Revenue this month", "Выручка за месяц"), fmt(salesTotals.monthRevenue)],
                [L("Revenue this year", "Выручка за год"), fmt(salesTotals.yearRevenue)]].map(([label, val]) => (
                <div key={label} className="rounded-2xl p-4" style={{ background: P.card, border: `1px solid ${P.line}` }}>
                  <div className="text-xs font-bold" style={{ color: P.sub }}>{label}</div>
                  <div className="font-extrabold mt-1" style={{ fontFamily: FONT_DISPLAY, fontSize: "clamp(13px,2.5vw,18px)" }}>{val}</div>
                </div>
              ))}
            </div>
            <section className="rounded-2xl p-5 mb-6" style={{ background: P.card, border: `1px solid ${P.line}` }}>
              <div className="flex items-center justify-between gap-3 mb-4">
                <div>
                  <h2 className="font-extrabold" style={{ fontFamily: FONT_DISPLAY, fontSize: 18 }}>
                    {L("Sales history", "История продаж")}
                  </h2>
                  <p className="text-xs mt-1" style={{ color: P.sub }}>
                    {L(
                      "Stored permanently from website orders.",
                      "Хранится постоянно на основе заказов с сайта.",
                    )}
                  </p>
                </div>
                <button type="button" onClick={loadSalesHistory} disabled={historyLoading}
                  aria-label={L("Refresh sales history", "Обновить историю продаж")}
                  className="shrink-0 w-9 h-9 rounded-full font-extrabold"
                  style={{ background: P.bone, border: `1px solid ${P.line}`, opacity: historyLoading ? 0.55 : 1 }}>
                  {historyLoading ? "..." : "↻"}
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {[
                  ["weeks", L("Weeks", "Недели")],
                  ["months", L("Months", "Месяцы")],
                  ["years", L("Years", "Годы")],
                ].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setHistoryPeriod(value)}
                    aria-pressed={historyPeriod === value}
                    className="text-xs font-extrabold px-3 py-2 rounded-full"
                    style={{
                      background: historyPeriod === value ? P.ink : P.bone,
                      color: historyPeriod === value ? "#fff" : P.txt,
                      border: `1px solid ${historyPeriod === value ? P.ink : P.line}`,
                    }}>
                    {label}
                  </button>
                ))}
              </div>
              {historyError && (
                <div className="rounded-xl px-4 py-3 text-sm font-bold" style={{ background: "#FAE5E3", color: "#933A34" }}>
                  {L("Could not load history. Please refresh it.", "Не удалось загрузить историю. Обновите её.")}
                </div>
              )}
              {!historyError && historyLoading && salesHistory[historyPeriod].length === 0 && (
                <div className="text-sm py-3" style={{ color: P.sub }}>{L("Loading history...", "Загрузка истории...")}</div>
              )}
              {!historyError && !historyLoading && salesHistory[historyPeriod].length === 0 && (
                <div className="text-sm py-3" style={{ color: P.sub }}>{L("No sales recorded yet.", "Продаж пока нет.")}</div>
              )}
              {!historyError && salesHistory[historyPeriod].length > 0 && (
                <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
                  {salesHistory[historyPeriod].map((item) => (
                    <div key={item.key} className="rounded-xl p-4" style={{ background: P.bone }}>
                      <div className="font-extrabold text-sm">
                        {salesHistoryPeriodLabel(item, historyPeriod, lang)}
                      </div>
                      <div className="grid grid-cols-3 gap-2 mt-3 pt-3" style={{ borderTop: `1px solid ${P.line}` }}>
                        {[
                          [L("Orders", "Заказы"), String(item.orders)],
                          [L("Revenue", "Выручка"), fmt(item.revenue)],
                          [L("Average check", "Средний чек"), fmt(item.average)],
                        ].map(([label, value]) => (
                          <div key={label} className="min-w-0">
                            <div className="text-[10px] sm:text-xs font-bold" style={{ color: P.sub }}>{label}</div>
                            <div className="text-xs sm:text-sm font-extrabold mt-1 break-words">{value}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <div className="rounded-2xl p-5" style={{ background: P.card, border: `1px solid ${P.line}` }}>
              <div className="font-extrabold mb-4" style={{ fontFamily: FONT_DISPLAY, fontSize: 14 }}>{L("Top dishes (all time)", "Топ блюд (за всё время)")}</div>
              {top.length === 0 ? (
                <div className="text-sm" style={{ color: P.sub }}>{L("No completed orders yet.", "Завершённых заказов пока нет.")}</div>
              ) : top.map(([name, qty]) => (
                <div key={name} className="mb-3">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold">{name}</span>
                    <span style={{ color: P.sub }}>× {qty}</span>
                  </div>
                  <div className="h-2 rounded-full" style={{ background: P.bone }}>
                    <div className="h-2 rounded-full" style={{ background: P.teal, width: `${Math.round((qty / maxTop) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-6">
              {Object.keys(STATUS).filter((s) => s !== "pending" && s !== "awaiting_confirmation").map((s) => (
                <div key={s} className="rounded-xl p-3 text-center" style={{ background: STATUS[s].bg }}>
                  <div className="font-extrabold text-lg" style={{ color: STATUS[s].fg }}>{orders.filter((o) => o.status === s).length}</div>
                  <div className="text-xs font-bold" style={{ color: STATUS[s].fg }}>{STATUS[s][lang]}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "finance" && (
          <>
            {/* commission balance — visible to the cafe. Calculated as 1% of every order total. */}
            <div className="rounded-2xl p-6 mb-6" style={{ background: P.ink, color: "#fff" }}>
              <div className="text-xs font-bold uppercase tracking-wide" style={{ color: "rgba(255,255,255,.6)" }}>
                {L("Current commission balance", "Текущий баланс комиссии")}
              </div>
              <div className="font-extrabold mt-2" style={{ fontFamily: FONT_DISPLAY, fontSize: 38 }}>
                {ledger ? fmt(ledger.balance) : "…"}
              </div>
              <div className="text-xs mt-1" style={{ color: "rgba(255,255,255,.6)" }}>
                {L("Platform fee owed to us (1% of every paid order)", "Комиссия платформы к оплате (1% от каждого оплаченного заказа)")}
              </div>
              {ledger && (
                <div className="flex gap-4 mt-4 text-xs" style={{ color: "rgba(255,255,255,.7)" }}>
                  <span>{L("Accrued", "Начислено")}: <b style={{ color: "#fff" }}>{fmt(ledger.accrued)}</b></span>
                  <span>{L("Paid out", "Выплачено")}: <b style={{ color: "#fff" }}>{fmt(ledger.paid)}</b></span>
                </div>
              )}
            </div>

            {/* super-admin: settle + history */}
            <div className="rounded-2xl p-5" style={{ background: P.card, border: `1px solid ${P.line}` }}>
              <div className="font-extrabold mb-3" style={{ fontFamily: FONT_DISPLAY, fontSize: 14 }}>{L("Platform owner (super-admin)", "Владелец платформы (супер-админ)")}</div>
              {!isSuper ? (
                <div className="flex gap-2 items-center">
                  <input type="password" inputMode="numeric" value={superPin} onChange={(e) => setSuperPin(e.target.value)}
                    placeholder={L("Super-admin PIN", "PIN супер-админа")}
                    className="flex-1 rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: P.bone, border: `1px solid ${P.line}`, color: P.txt }} />
                  <button onClick={() => { if (superPin === "246808642") setIsSuper(true); else setSuperPin(""); }}
                    className="text-sm font-bold px-4 py-2.5 rounded-xl" style={{ background: P.ink, color: "#fff" }}>
                    {L("Unlock", "Открыть")}
                  </button>
                </div>
              ) : (
                <>
                  <div className="rounded-xl p-3 mb-3 flex items-center justify-between" style={{ background: P.bone }}>
                    <div className="text-sm">
                      <div className="font-bold" style={{ color: P.txt }}>{L("When the cafe transfers the fee to you:", "Когда кафе переведёт комиссию вам:")}</div>
                      <div className="text-xs" style={{ color: P.sub }}>{L("Mark it paid — balance resets to 0 and a payout is logged.", "Отметьте как оплачено — баланс обнулится, выплата сохранится в истории.")}</div>
                    </div>
                  </div>
                  <button onClick={settle} disabled={settling || !ledger || ledger.balance <= 0}
                    className="w-full py-3 rounded-xl font-extrabold mb-4"
                    style={{ background: (!ledger || ledger.balance <= 0) ? P.line : P.saff, color: "#241819", opacity: settling ? 0.6 : 1 }}>
                    {settling ? "…" : `${L("Reset balance / Mark as paid", "Сбросить баланс / Отметить как оплачено")} (${ledger ? fmt(ledger.balance) : "…"})`}
                  </button>

                  <div className="text-xs font-bold mb-2" style={{ color: P.sub }}>{L("History", "История")}</div>
                  <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
                    {ledger && ledger.history.length === 0 && <div className="text-xs" style={{ color: P.sub }}>{L("No transactions yet.", "Операций пока нет.")}</div>}
                    {ledger && ledger.history.map((h, i) => (
                      <div key={i} className="flex items-center justify-between text-xs rounded-lg px-3 py-2" style={{ background: P.bone }}>
                        <span style={{ color: P.sub }}>
                          {dateOf(h.ts)} {timeOf(h.ts)} · {h.type === "accrual" ? `${h.note || L("Commission", "Комиссия")}` : `${L("Payout", "Выплата")}`}
                        </span>
                        <span className="font-bold" style={{ color: h.type === "accrual" ? "#3F7A2E" : "#933A34" }}>
                          {h.type === "accrual" ? "+" : "−"}{fmt(h.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* --- SCHEDULE MANAGER TAB --- */}
        {tab === "schedule" && (
          <div className="rounded-2xl p-6" style={{ background: P.card, border: `1px solid ${P.line}` }}>
            <div className="flex justify-between items-center mb-2">
              <div className="font-extrabold" style={{ fontFamily: FONT_DISPLAY, fontSize: 18 }}>{L("Operating Hours", "Режим работы")}</div>
              <button
                onClick={() => saveCafeStatus({ ...cafeInfo, isOpen: !cafeInfo.isOpen })}
                className="px-6 py-2 rounded-full font-extrabold text-sm"
                style={{ background: cafeInfo.isOpen ? "#5E8C4A" : "#C7514A", color: "#fff" }}
              >
                {cafeInfo.isOpen ? "✓ Открыто" : "✕ Закрыто"}
              </button>
            </div>
            <div className="text-xs font-bold mb-6" style={{ color: cafeInfo.effectiveOpen === false ? "#933A34" : "#3F7A2E" }}>
              {cafeInfo.effectiveOpen === false
                ? L("Currently closed for orders (outside hours or manually closed)", "Сейчас заказы не принимаются (нерабочее время или закрыто вручную)")
                : L("✓ Currently accepting orders", "✓ Сейчас заказы принимаются")}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {days.map(day => (
                <div key={day} className="p-3 rounded-xl" style={{ background: P.bone }}>
                  <div className="text-xs font-bold mb-2 uppercase" style={{ color: P.sub }}>{day}</div>
                  <input
                    type="text"
                    value={hoursDraft[day] || ""}
                    onChange={(e) => setHoursDraft((current) => ({ ...current, [day]: e.target.value }))}
                    placeholder="08:00-01:00"
                    className="w-full text-sm font-bold p-2 rounded-lg outline-none text-center"
                    style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }}
                  />
                </div>
              ))}
            </div>
            <button onClick={saveHours} className="mt-3 px-6 py-2.5 rounded-full font-extrabold text-sm"
              style={{ background: P.teal, color: "#fff" }}>
              {L("Save hours", "Сохранить часы")}
            </button>

            {/* Delivery fee rings. Staff can edit radius and price and can
                add or remove rings. The customer map uses these settings. */}
            <div className="font-extrabold mt-8 mb-1" style={{ fontFamily: FONT_DISPLAY, fontSize: 16 }}>{L("Delivery zones", "Зоны доставки")}</div>
            <div className="text-xs mb-3" style={{ color: P.sub }}>
              {L("Set a radius and price for each zone. Radii must increase; outside the last zone delivery is refused.",
                 "Укажите радиус и цену каждой зоны. Радиусы должны возрастать; вне последней зоны доставка недоступна.")}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {zoneDraft.map((zone, i) => (
                <div key={i} className="p-3 rounded-xl" style={{ background: P.bone }}>
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <div className="text-xs font-extrabold" style={{ color: deliveryZoneColor(i, zoneDraft.length) }}>
                      <span aria-hidden="true">●</span> {L(`Zone ${i + 1}`, `Зона ${i + 1}`)}
                    </div>
                    {zoneDraft.length > 1 && (
                      <button type="button" onClick={() => removeZone(i)}
                        className="text-[11px] font-extrabold px-2.5 py-1 rounded-full"
                        style={{ background: "#FAE5E3", color: "#933A34" }}>
                        {L("Remove", "Удалить")}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="min-w-0">
                      <span className="block text-[11px] font-bold mb-1" style={{ color: P.sub }}>
                        {L("Radius, km", "Радиус, км")}
                      </span>
                      <input type="number" min="0.1" max="100" step="0.1" inputMode="decimal"
                        value={zone.km}
                        onChange={(e) => updateZoneDraft(i, "km", e.target.value)}
                        className="w-full text-sm font-bold p-2 rounded-lg outline-none text-center"
                        style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }} />
                    </label>
                    <label className="min-w-0">
                      <span className="block text-[11px] font-bold mb-1" style={{ color: P.sub }}>
                        {L("Price, ₸", "Цена, ₸")}
                      </span>
                      <input type="number" min="0" max="100000" step="50" inputMode="numeric"
                        value={zone.fee}
                        onChange={(e) => updateZoneDraft(i, "fee", e.target.value)}
                        className="w-full text-sm font-bold p-2 rounded-lg outline-none text-center"
                        style={{ background: P.card, border: `1px solid ${P.line}`, color: P.txt }} />
                    </label>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={addZone}
                disabled={zoneDraft.length >= MAX_DELIVERY_ZONES}
                className="px-5 py-2.5 rounded-full font-extrabold text-sm"
                style={{ background: P.bone, color: P.txt, border: `1px solid ${P.line}`, opacity: zoneDraft.length >= MAX_DELIVERY_ZONES ? 0.5 : 1 }}>
                + {L("Add zone", "Добавить зону")}
              </button>
              <button onClick={saveZones} className="px-6 py-2.5 rounded-full font-extrabold text-sm"
                style={{ background: P.teal, color: "#fff" }}>
                {L("Save zones", "Сохранить зоны")}
              </button>
            </div>
          </div>
        )}
      </main>

      {(adding || editing) && (
        <ItemForm lang={lang} initial={editing} onClose={() => { setAdding(false); setEditing(null); }}
          onSave={(f) => {
            if (editing) saveMenu(menu.map((x) => (x.id === f.id ? f : x)));
            else saveMenu([...menu, f]);
            setAdding(false); setEditing(null);
          }} />
      )}
    </div>
  );
}

/* ── root app ────────────────────────────────────────────────────────── */

export default function App() {
  const [lang, setLang] = useState("ru");
  const [view, setView] = useState("site");
  const [authed, setAuthed] = useState(false);
  const [menu, setMenu] = useState(null);
  const [orders, setOrders] = useState([]);
  const [cart, setCart] = useState({});
  const [cartOpen, setCartOpen] = useState(false);
  const [lastOrder, setLastOrder] = useState(null);
  const [cafeInfo, setCafeInfo] = useState({ isOpen: true, hours: {} });
  const [boardOpen, setBoardOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [bonusOpen, setBonusOpen] = useState(false);
  const [loyalty, setLoyalty] = useState(null);
  const [loyaltyCode, setLoyaltyCode] = useState(() => localStorage.getItem(LOYALTY_CODE_KEY) || "");
  const [loyaltyLoading, setLoyaltyLoading] = useState(false);

  const t = useCallback((k) => T[lang][k] || k, [lang]);
  const refreshLoyalty = useCallback(async () => {
    setLoyaltyLoading(true);
    const result = await apiGetLoyalty();
    if (result !== LOYALTY_RATE_LIMITED) {
      setLoyalty(result);
      setLoyaltyCode(localStorage.getItem(LOYALTY_CODE_KEY) || "");
    }
    setLoyaltyLoading(false);
    return result;
  }, []);
  const connectLoyalty = useCallback(async (rawCode) => {
    const code = normalizeLoyaltyCodeInput(rawCode);
    if (!isValidLoyaltyCode(code)) return null;
    const result = await apiGetLoyalty(code);
    if (result === LOYALTY_RATE_LIMITED) return LOYALTY_RATE_LIMITED;
    if (!result || !saveLoyaltyCode(code)) return null;
    setLoyaltyCode(code);
    setLoyalty(result);
    return result;
  }, []);
  const forgetLoyalty = useCallback(() => {
    localStorage.removeItem(LOYALTY_CODE_KEY);
    localStorage.removeItem(LEGACY_LOYALTY_TOKEN_KEY);
    setLoyaltyCode("");
    setLoyalty(null);
  }, []);
  const rotateLoyalty = useCallback(async () => {
    const result = await apiRotateLoyalty();
    if (!result) return null;
    setLoyaltyCode(result.code);
    setLoyalty(result);
    return result;
  }, []);

    useEffect(() => {
    (async () => {
      const m = await apiGetMenu();
      setMenu(m && Array.isArray(m) && m.length ? m : SEED);
      const o = await apiGetOrders();
      setOrders(Array.isArray(o) ? o : []);
      // Restore order tracking after a reload (last 24h only) so the customer
      // keeps seeing status updates and notifications for their active order.
      try {
        const saved = JSON.parse(localStorage.getItem("aspan-last-order") || "null");
        if (saved && saved.id && Date.now() - (saved.ts || 0) < 24 * 3600 * 1000) setLastOrder(saved);
      } catch (e) {}
      const status = await apiGetCafeStatus();
      if (status) setCafeInfo(status);
      await refreshLoyalty();
    })();
  }, [refreshLoyalty]);

  // Re-check open/closed periodically so a tab left open across closing
  // time (e.g. past 01:00) reflects it without needing a manual reload.
  useEffect(() => {
    const tm = setInterval(async () => {
      const status = await apiGetCafeStatus();
      if (status) setCafeInfo(status);
    }, 60000);
    return () => clearInterval(tm);
  }, []);

  const refreshOrders = useCallback(async () => {
    const o = await apiGetOrders();
    if (Array.isArray(o)) setOrders(o);
  }, []);

  const saveMenu = useCallback(async (next) => {
    const previous = menu;
    setMenu(next);
    const result = await apiSaveMenu(next);
    if (result === true) return true;
    setMenu(previous);
    if (result === "auth") {
      localStorage.removeItem("aspan-token");
      alert(lang === "en" ? "Your session has expired. Please sign in again." : "Сессия истекла. Пожалуйста, войдите снова.");
      window.location.reload();
      return false;
    }
    alert(lang === "en" ? "The menu was not saved. Check your connection and try again." : "Меню не сохранено. Проверьте соединение и попробуйте ещё раз.");
    return false;
  }, [menu, lang]);

  const saveCafeStatus = async (data) => {
    const result = await apiUpdateCafeStatus(data);
    if (result !== true) {
      if (result === "auth") {
        localStorage.removeItem("aspan-token");
        alert(lang === "en" ? "Your session has expired. Please sign in again." : "Сессия истекла. Пожалуйста, войдите снова.");
        window.location.reload();
      } else {
        alert(lang === "en" ? "Settings were not saved. Check the values and try again." : "Настройки не сохранены. Проверьте значения и попробуйте ещё раз.");
      }
      return false;
    }
    // Re-fetch rather than trusting the PUT body locally: effectiveOpen is
    // computed server-side only, so staff see the real open/closed result
    // immediately instead of a stale value until the next 60s poll.
    const fresh = await apiGetCafeStatus();
    setCafeInfo(fresh || data);
    return true;
  };

  const setQty = useCallback((id, q) => {
    setCart((p) => {
      const n = { ...p };
      if (q <= 0) delete n[id]; else n[id] = q;
      return n;
    });
  }, []);

  const placeOrder = useCallback(async (payload) => {
    const latest = await apiGetOrders() || [];
    const num = latest.reduce((mx, o) => Math.max(mx, o.num || 0), 100) + 1;
    // Unguessable id: it doubles as the access key for reading this order's
    // full details back (GET /api/orders/<id>), so timestamp-based ids are
    // not enough — anyone could enumerate those.
    const oid = "o" + ((typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12));
    const order = { id: oid, num, ts: Date.now(), status: payload.status || "new", ...payload };
    const result = await apiPlaceOrder(order);
    if (!result) return null; // caller shows the error; nothing is stored locally
    if (result.loyalty?.code) {
      saveLoyaltyCode(result.loyalty.code);
      setLoyaltyCode(result.loyalty.code);
    }
    if (result.loyalty) {
      setLoyalty(result.loyalty);
    }
    const savedOrder = {
      ...order,
      ...(result.order || {}),
      ...(result.loyalty?.code ? { issuedLoyaltyCode: result.loyalty.code } : {}),
    };
    setOrders((prev) => [savedOrder, ...prev]);
    setLastOrder(savedOrder);
    try { localStorage.setItem("aspan-last-order", JSON.stringify({ id: savedOrder.id, num: savedOrder.num, ts: savedOrder.ts })); } catch (e) {}
    setCart({});
    return savedOrder;
  }, []);

  const updateStatus = useCallback(async (id, status, extra) => {
    const res = await apiUpdateStatus(id, status, extra);
    if (res === "auth") {
      // Token expired mid-session: bounce to the login screen instead of
      // pretending the update worked and letting the poll revert it.
      localStorage.removeItem("aspan-token");
      alert(lang === "en" ? "Your session has expired. Please sign in again." : "Сессия истекла. Пожалуйста, войдите снова.");
      window.location.reload();
      return;
    }
    if (res !== true) {
      alert(lang === "en" ? "Failed to update the order. Check your connection and try again." : "Не удалось обновить заказ. Проверьте соединение и попробуйте ещё раз.");
      refreshOrders();
      return;
    }
    // Optimistic mirror of the server-side prep fields so the countdown
    // shows immediately; the next orders poll overwrites with server values.
    const prep = extra && extra.preparation_minutes
      ? { preparation_minutes: extra.preparation_minutes, preparation_started_at: Date.now(), estimated_ready_at: Date.now() + extra.preparation_minutes * 60000 }
      : {};
    setOrders((prev) => prev.map((o) => o.id === id ? { ...o, status, ...prep } : o));
  }, [lang, refreshOrders]);

  const ackCall = useCallback(async (id) => {
    const ok = await apiAckCall(id);
    if (ok) setOrders((prev) => prev.map((o) => o.id === id ? { ...o, callConfirmed: true } : o));
    else refreshOrders();
  }, [refreshOrders]);

  // Staff record the departure time learned during the confirmation call;
  // it immediately reshapes availability for other clients.
  const setBookingEnd = useCallback(async (id, endTime) => {
    const ok = await apiSetBookingEnd(id, endTime);
    if (ok) setOrders((prev) => prev.map((o) => o.id === id && o.booking ? { ...o, booking: { ...o.booking, endTime } } : o));
    else refreshOrders();
    return ok;
  }, [refreshOrders]);

  const cartCount = Object.values(cart).reduce((s, q) => s + q, 0);
  const cartTotal = Object.entries(cart).reduce((s, [cartId, q]) => {
    const r = resolveCartLine(menu, cartId); return s + (r ? r.price * q : 0);
  }, 0);

  if (!menu) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: P.bone }}>
        <div className="text-center">
          <Logo h={72} className="mx-auto" />
          <div className="text-sm mt-3" style={{ color: P.sub }}>{lang === "en" ? "Setting the tables…" : "Накрываем столы…"}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: FONT_BODY }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Manrope:wght@400;500;700;800&display=swap');
        * { box-sizing: border-box; }
        ::placeholder { color: #A99C92; }
        button { cursor: pointer; border: none; font-family: inherit; }
        a { color: inherit; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.75; } }
        @keyframes consentShake { 10%,90%{transform:translateX(-1px)} 20%,80%{transform:translateX(2px)} 30%,50%,70%{transform:translateX(-5px)} 40%,60%{transform:translateX(5px)} }
        .consent-shake { animation: consentShake .5s cubic-bezier(.36,.07,.19,.97); }
        .consent-box:focus-within .consent-tick { outline: 2px solid #742427; outline-offset: 2px; }
        .brand-wordmark { display: none; }
        @media (max-width: 520px) { .bonus-label { display: none; } }
        @media (min-width: 640px) { .brand-wordmark { display: block; } }
      `}</style>

      {view === "site" ? (
        <>
          <GuestSite lang={lang} setLang={setLang} t={t} menu={menu} cart={cart} setQty={setQty} cafeInfo={cafeInfo}
            openCart={() => setCartOpen(true)} cartCount={cartCount} cartTotal={cartTotal}
            goAdmin={() => setView("admin")} lastOrder={lastOrder} orders={orders}
            openBoard={() => setBoardOpen(true)}
            openPrivacy={() => setPrivacyOpen(true)}
            loyalty={loyalty} openBonuses={() => setBonusOpen(true)} />
          <LoyaltyDrawer open={bonusOpen} onClose={() => setBonusOpen(false)}
            loyalty={loyalty} loyaltyCode={loyaltyCode} loading={loyaltyLoading}
            refresh={refreshLoyalty} connectLoyalty={connectLoyalty}
            forgetLoyalty={forgetLoyalty} rotateLoyalty={rotateLoyalty} lang={lang} />
          <OrdersBoard open={boardOpen} onClose={() => setBoardOpen(false)} orders={orders}
            lang={lang} t={t} refreshOrders={refreshOrders} />
          <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} cart={cart} menu={menu}
            lang={lang} t={t} setQty={setQty} placeOrder={placeOrder} lastOrder={lastOrder}
            orders={orders} refreshOrders={refreshOrders} resetAfterOrder={() => setLastOrder(lastOrder)}
            kaspiUrl={safeKaspiUrl(cafeInfo && cafeInfo.kaspiPayUrl)}
            isClosed={cafeInfo ? cafeInfo.effectiveOpen === false : false}
            openPrivacy={() => setPrivacyOpen(true)} cafeInfo={cafeInfo}
            loyalty={loyalty} refreshLoyalty={refreshLoyalty}
            connectLoyalty={connectLoyalty} forgetLoyalty={forgetLoyalty} />
          <PrivacyPolicy open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
        </>
      ) : authed ? (
        <AdminPanel lang={lang} setLang={setLang} menu={menu} saveMenu={saveMenu} orders={orders} cafeInfo={cafeInfo} saveCafeStatus={saveCafeStatus}
          updateStatus={updateStatus} ackCall={ackCall} setBookingEnd={setBookingEnd} refreshOrders={refreshOrders} goSite={() => setView("site")}
        />
      ) : (
        <PinGate lang={lang} onOk={() => setAuthed(true)} goSite={() => setView("site")} />
      )}
    </div>
  );

}
