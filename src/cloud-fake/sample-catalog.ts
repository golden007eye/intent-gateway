// Demo mode's sample catalog: about seventy plausible US offers across the everyday categories a developer tries
// first, from several `*.example` merchants each, with varied prices, shipping and stock. Some items exist for the
// seed policies: electronics (`no-electronics`), drop-ship merchants (`block-dropship`) and items over $60
// (`per-order-60`). The items in categories Intent Cloud excludes (health, alcohol, tobacco, weapons, gift cards)
// are here only so that the demo Intent Cloud, started with `excludedCategories`, refuses them as the real one does.
import type { Merchant } from "../contract/index.ts";
import type { CatalogItem } from "./catalog.ts";

const M = {
  trail: { name: "Trail Supply Co", domain: "shop.example" },
  runners: { name: "Road Runners", domain: "runners.example" },
  peak: { name: "Peak Outfitters", domain: "peak.example" },
  hydra: { name: "Hydra Goods", domain: "hydra.example" },
  kitchen: { name: "Kitchen Corner", domain: "kitchen.example" },
  brew: { name: "Bean & Brew", domain: "brew.example" },
  sound: { name: "Sound House", domain: "sound.example" },
  charge: { name: "Charge Point", domain: "charge.example" },
  cases: { name: "Case Lab", domain: "cases.example" },
  bags: { name: "Bag Works", domain: "bags.example" },
  books: { name: "Page Turner Books", domain: "books.example" },
  play: { name: "Play Shed", domain: "play.example" },
  home: { name: "Home Basics", domain: "homebasics.example" },
  paper: { name: "Paper Lane", domain: "paper.example" },
  camp: { name: "Camp Hollow", domain: "camp.example" },
  paws: { name: "Paws & Co", domain: "paws.example" },
  glow: { name: "Glow Shop", domain: "glow.example" },
  gifts: { name: "Gift Nook", domain: "gifts.example" },
  // Drop-shippers, for `block-dropship`. They quote a ceiling, not an exact total.
  resaleDepot: { name: "Resale Depot", domain: "dropship.example" },
  resale: { name: "Resale Hub", domain: "resale.example" },
  // Excluded categories only.
  wellness: { name: "Wellness Shop", domain: "wellness.example" },
  cellar: { name: "Cellar Door", domain: "cellar.example" },
  smoke: { name: "Smoke Shop", domain: "smoke.example" },
  blade: { name: "Blade Outlet", domain: "blade.example" },
} satisfies Record<string, Merchant>;

const DROPSHIP: ReadonlySet<string> = new Set([M.resaleDepot.domain, M.resale.domain]);

type Row = [category: string, merchant: Merchant, title: string, variant: string, price: number, shipping: number, stock: number, tags: string];

// Prices and shipping in cents. A stock of 3 or less shows as low stock.
const ROWS: readonly Row[] = [
  // Running shoes
  ["sports/running-shoes", M.trail, "Trail Runner 3", "US 10 / Blue", 8999, 500, 10, "trail running mens"],
  ["sports/running-shoes", M.runners, "Road Runner 2", "US 9 / Black", 6499, 0, 2, "road running mens"],
  ["sports/running-shoes", M.runners, "Road Runner 2", "US 10 / Black", 6499, 0, 8, "road running mens"],
  ["sports/running-shoes", M.peak, "Cloudstep Daily Trainer", "US 8 Women's / Grey", 7400, 0, 12, "road running cushioned womens"],
  ["sports/running-shoes", M.trail, "Ridgeline Trail Shoe", "US 11 / Olive", 10900, 0, 6, "trail running waterproof mens"],
  ["sports/running-shoes", M.runners, "Tempo Lite Racer", "US 10 / Red", 12900, 0, 3, "road running racing lightweight"],
  ["sports/running-shoes", M.resale, "Budget Running Shoe", "US 9 / White", 3499, 699, 40, "road running"],
  // Water bottles and drinkware
  ["kitchen/drinkware/water-bottles", M.hydra, "Summit Insulated Water Bottle", "32 oz / Stainless", 2499, 499, 25, "stainless steel insulated vacuum leak-proof bpa-free"],
  ["kitchen/drinkware/water-bottles", M.kitchen, "Everyday Stainless Water Bottle", "1 L / Brushed Steel", 1850, 0, 30, "stainless steel leak-proof dishwasher-safe"],
  ["kitchen/drinkware/water-bottles", M.peak, "Trailhead Water Bottle", "750 ml / Blue", 1400, 350, 18, "stainless steel insulated"],
  ["kitchen/drinkware/water-bottles", M.home, "Clear Sport Water Bottle", "1 L / Clear", 999, 299, 50, "plastic tritan bpa-free leak-proof"],
  ["kitchen/drinkware/water-bottles", M.play, "Kids Sip Water Bottle", "12 oz / Dinosaur", 1299, 399, 3, "stainless steel kids straw"],
  ["kitchen/drinkware/water-bottles", M.hydra, "Glacier Tumbler with Straw", "40 oz / Sage", 3495, 500, 14, "stainless steel insulated straw"],
  ["kitchen/drinkware/mugs", M.resaleDepot, "Ceramic Mug", "12 oz / White", 1200, 400, 50, "ceramic coffee"],
  ["kitchen/drinkware/mugs", M.brew, "Travel Coffee Mug", "16 oz / Black", 1999, 0, 22, "stainless steel insulated leak-proof coffee"],
  // Coffee
  ["kitchen/coffee", M.brew, "Pour-Over Coffee Dripper", "Ceramic / White", 2200, 0, 15, "pour-over ceramic"],
  ["kitchen/coffee", M.kitchen, "French Press", "34 oz / Glass", 2995, 499, 9, "coffee glass stainless"],
  ["kitchen/coffee", M.brew, "Manual Burr Coffee Grinder", "Stainless", 3900, 0, 7, "grinder burr manual stainless"],
  ["kitchen/coffee", M.brew, "Whole Bean Coffee, Medium Roast", "12 oz bag", 1450, 399, 60, "beans whole-bean medium-roast"],
  ["kitchen/coffee", M.home, "Drip Coffee Maker", "12 cup / Black", 4999, 0, 5, "drip machine programmable"],
  // Kitchen
  ["kitchen/cookware", M.kitchen, "Cast Iron Skillet", "10 in", 2799, 599, 20, "cast-iron pan pre-seasoned"],
  ["kitchen/cookware", M.home, "Nonstick Frying Pan", "8 in", 1999, 0, 16, "nonstick pan"],
  ["kitchen/kitchen-knives", M.kitchen, "Chef's Knife", "8 in / Stainless", 3400, 0, 11, "chef stainless cooking"],
  ["kitchen/kitchen-tools", M.kitchen, "Bamboo Cutting Board", "Large", 1699, 399, 25, "bamboo board"],
  ["kitchen/food-storage", M.resaleDepot, "Glass Food Storage Containers", "10-piece set", 2999, 0, 30, "glass containers lids meal-prep"],
  // Headphones
  ["electronics/headphones", M.sound, "Studio Headphones", "Black", 12900, 0, 5, "wireless noise-cancelling over-ear"],
  ["electronics/headphones", M.sound, "Wireless Earbuds", "Black", 3999, 0, 30, "wireless bluetooth earbuds charging-case"],
  ["electronics/headphones", M.charge, "Over-Ear Bluetooth Headphones", "Noise Cancelling / Silver", 7900, 0, 8, "wireless bluetooth noise-cancelling over-ear"],
  ["electronics/headphones", M.play, "Kids Volume-Limited Headphones", "Blue", 1999, 399, 20, "kids wired volume-limited"],
  // Phone accessories
  ["electronics/phone-accessories", M.charge, "USB-C Fast Charger", "30 W / White", 1999, 0, 40, "phone charger usb-c fast-charging"],
  ["electronics/phone-accessories", M.charge, "Braided USB-C Cable", "6 ft / 2-pack", 1299, 0, 60, "phone cable usb-c braided"],
  ["electronics/phone-accessories", M.charge, "Portable Power Bank", "10000 mAh / Black", 2999, 0, 12, "phone battery charger usb-c"],
  ["phone-accessories/phone-cases", M.cases, "Clear Phone Case", "6.1 in / Clear", 1499, 0, 35, "phone case clear shockproof"],
  ["phone-accessories/phone-stands", M.cases, "Aluminum Phone Stand", "Silver", 1599, 399, 18, "phone stand desk adjustable"],
  // Backpacks
  ["bags/backpacks", M.bags, "Everyday Backpack", "24 L / Charcoal", 4900, 0, 14, "laptop-sleeve water-resistant commuter"],
  ["bags/backpacks", M.bags, "Laptop Backpack", "15.6 in / Black", 5999, 0, 9, "laptop water-resistant travel"],
  ["bags/backpacks", M.peak, "Hiking Daypack", "20 L / Green", 3995, 500, 11, "hiking outdoor lightweight"],
  ["bags/backpacks", M.play, "Kids School Backpack", "Rainbow", 2499, 399, 2, "kids school"],
  // Books
  ["books/fiction", M.books, "The Quiet Trail", "Paperback", 1699, 399, 25, "novel paperback fiction"],
  ["books/cookbooks", M.books, "A Beginner's Guide to Sourdough", "Hardcover", 2400, 399, 10, "cookbook baking bread hardcover"],
  ["books/nature-books", M.books, "Field Guide to North American Birds", "Paperback", 1995, 399, 15, "birds field-guide paperback"],
  ["books/childrens-books", M.books, "Moon Over the Harbor", "Hardcover picture book", 1299, 399, 20, "kids picture-book hardcover"],
  // Toys and games
  ["toys-games/toys", M.play, "Wooden Building Blocks", "50 pieces", 2999, 0, 12, "kids wooden blocks toddler"],
  ["toys-games/board-games", M.play, "Harbor Lights Strategy Board Game", "2-4 players", 3499, 0, 8, "board-game family strategy"],
  ["toys-games/puzzles", M.play, "Mountain Lake Jigsaw Puzzle", "1000 pieces", 1899, 399, 15, "jigsaw puzzle"],
  ["toys-games/card-games", M.gifts, "Party Card Game", "Base set", 1299, 399, 30, "card-game party family gift"],
  // Home basics
  ["home/bath", M.home, "Cotton Bath Towel Set", "4 pieces / White", 3999, 0, 10, "towels cotton bath"],
  ["home/lamps", M.home, "LED Desk Lamp", "White", 2299, 0, 18, "led lamp desk dimmable"],
  ["home/cleaning", M.home, "Microfiber Cleaning Cloths", "12-pack", 999, 0, 70, "cleaning microfiber cloths"],
  ["home/decor", M.gifts, "Lavender Soy Candle", "8 oz jar", 1600, 399, 22, "candle soy lavender gift"],
  ["home/home-storage", M.resale, "Fabric Storage Bins", "3-pack / Grey", 2199, 0, 25, "storage bins baskets"],
  // Office supplies
  ["office-supplies/notebooks", M.paper, "Dot Grid Notebook", "A5 / Black", 1499, 0, 40, "notebook journal dot-grid hardcover"],
  ["office-supplies/pens", M.paper, "Gel Pens", "12-pack / 0.7 mm", 949, 0, 50, "pens gel assorted"],
  ["office-supplies/desk-organizers", M.paper, "Bamboo Desk Organizer", "Natural", 2499, 399, 12, "desk organizer bamboo"],
  ["office-supplies/sticky-notes", M.paper, "Sticky Notes", "12 pads / Pastel", 799, 0, 80, "sticky-notes memo"],
  // Outdoor and camping
  ["outdoor/camping/tents", M.camp, "2-Person Backpacking Tent", "3-season / Green", 12900, 0, 4, "tent backpacking lightweight waterproof"],
  ["outdoor/camping/sleeping-bags", M.camp, "Three-Season Sleeping Bag", "30 °F / Regular", 6999, 0, 7, "sleeping-bag camping"],
  ["outdoor/camping/headlamps", M.camp, "Rechargeable Headlamp", "400 lumen", 2499, 0, 25, "headlamp light rechargeable usb-c waterproof"],
  ["outdoor/camping/camp-cooking", M.peak, "Compact Camp Stove", "Single burner", 3400, 500, 9, "stove backpacking cooking"],
  ["outdoor/camping/camp-cooking", M.camp, "Insulated Camp Mug", "12 oz / Stainless", 1695, 0, 20, "mug stainless steel insulated"],
  // Pet supplies
  ["pets/dog-supplies", M.paws, "Rope Chew Toy", "2-pack", 1199, 399, 30, "dog toy chew rope"],
  ["pets/dog-supplies", M.paws, "Reflective Dog Leash", "6 ft / Orange", 1599, 0, 18, "dog leash reflective"],
  ["pets/cat-supplies", M.paws, "Cat Scratching Post", "24 in / Sisal", 2999, 599, 6, "cat scratcher sisal"],
  ["pets/pet-bowls", M.paws, "Stainless Pet Bowls", "2-pack", 1349, 0, 25, "dog cat bowl stainless steel"],
  // Beauty basics
  ["beauty/skin-care", M.glow, "Daily Face Moisturizer", "1.7 fl oz / Fragrance-free", 1800, 0, 30, "moisturizer face fragrance-free"],
  ["beauty/lip-care", M.glow, "Shea Butter Lip Balm", "4-pack", 899, 0, 45, "lip-balm shea"],
  ["beauty/hair-care", M.glow, "Shampoo and Conditioner Set", "2 × 16 fl oz", 2250, 499, 14, "shampoo conditioner hair"],
  // Gifts under $30
  ["gifts/gift-sets", M.brew, "Coffee Lover Gift Box", "Sampler", 2800, 0, 10, "gift coffee sampler"],
  ["gifts/gift-sets", M.gifts, "Artificial Succulent Trio", "Ceramic pots", 1999, 399, 16, "gift plants decor"],
  ["gifts/keepsakes", M.gifts, "Leather Keychain", "Brown", 1400, 0, 40, "gift keychain leather"],
  ["gifts/gift-sets", M.resaleDepot, "Novelty Socks Gift Set", "3 pairs", 1699, 399, 50, "gift socks novelty"],
  // Excluded by Intent Cloud: the demo Intent Cloud never returns these.
  ["health/supplements", M.wellness, "Vitamin D3 Gummies", "60 count", 1499, 399, 20, "vitamin supplement"],
  ["alcohol/wine", M.cellar, "Cabernet Sauvignon", "750 ml", 2499, 999, 24, "wine red"],
  ["tobacco/cigars", M.smoke, "Premium Cigars", "5-pack", 3999, 599, 10, "cigar"],
  ["weapons/knives", M.blade, "Folding Hunting Knife", "3.5 in blade", 4499, 0, 8, "hunting knife folding"],
  ["gift-cards", M.gifts, "Store Gift Card", "$50", 5000, 0, 99, "gift-card gift"],
];

export const SAMPLE_CATALOG: readonly CatalogItem[] = Object.freeze(
  ROWS.map(([category, merchant, title, variant, price, shipping, stock, tags], i): CatalogItem => {
    const n = i + 1;
    return Object.freeze({
      category,
      tags: tags.split(" "),
      stock,
      merchant,
      title,
      variant,
      price: { amount_minor: price, currency: "USD" as const },
      shipping: { amount_minor: shipping, currency: "USD" as const },
      total_kind: DROPSHIP.has(merchant.domain) ? "max" : "exact",
      availability: stock <= 3 ? "low_stock" : "in_stock",
      image_url: `https://images.example/s${String(n).padStart(2, "0")}.webp`,
      delivery: { min_days: 2 + (n % 3), max_days: 5 + (n % 4) },
      rating: { stars_x10: 38 + (n % 12), count: 20 + ((n * 137) % 4000) },
      returns: { free: n % 2 === 0, days: n % 3 === 0 ? 60 : 30 },
    });
  }),
);
