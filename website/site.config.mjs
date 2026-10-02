/**
 * SellFlow website -- single source of truth.
 *
 * Everything release-specific lives here: version, build, size, date, the APK
 * path, and the changelog. `build.mjs` reads this file and stamps the values
 * into the HTML, so shipping a new build means editing one object and running
 * one command. Nothing about the release is hard-coded in the markup.
 *
 * Verified facts only. Ratings stay null while there are no real reviews --
 * the UI says "No ratings yet" rather than inventing stars. Play Store is not
 * claimed, because there is no listing.
 */

export const appConfig = {
  name: 'SellFlow',
  tagline: 'From order to delivered — all in one place.',
  shortDescription:
    'The mobile operating system for social-commerce sellers. Manage orders, products, inventory, customers, couriers, COD payments, finance and profit from one place.',
  /**
   * Supporting line under the hero headline. Deliberately not a restatement of
   * `shortDescription` -- the hero already leads with the positioning line, so
   * this one has to add something the headline does not say.
   */
  heroSupport:
    'Take orders, check stock, follow your courier and settle COD payments from one app — then see what the business actually keeps after every cost.',
  category: 'Business Management',
  /** Shown under the product name, the way a store lists the publisher. */
  developer: 'SellFlow',

  version: '1.0.0',
  buildNumber: '1',
  releaseDate: '2026-10-02',
  releaseDateLabel: '2 October 2026',
  /** Compact form for tight one-line UI such as the hero metadata strip. */
  releaseDateShort: '2 Oct 2026',
  releaseChannel: 'Latest preview release',

  platform: 'Android',
  /**
   * Where the APK is served from.
   *
   * External by design: a Vercel Hobby deployment caps static uploads at
   * 100 MB and the universal APK is 110.1 MB, so the binary lives on a GitHub
   * release and this page links to it directly.
   *
   * To self-host instead, point this at a path and drop the file in
   * public/downloads/ -- the build copies it into the deployment and validates
   * that it exists:
   *
   *   apkPath: 'downloads/sellflow-latest.apk',
   */
  apkPath: 'https://github.com/twosidegroup-spec/SELLFLOW/releases/download/v1.0.0/sellflow-1.0.0.apk',
  apkFileName: 'sellflow-1.0.0.apk',
  apkSizeBytes: 112735 * 1024,
  minAndroidVersion: 'Android 8.0 (API 26) or newer',
  abi: 'arm64-v8a, armeabi-v7a, x86_64',

  playStoreUrl: null, // no listing exists; the UI omits Play Store entirely
  ratings: null, // no real reviews yet
  reviewCount: 0,

  supportEmail: 'support@sellflow.app',
  year: 2026,
};

/**
 * Screenshots. Every entry is a real capture of the shipped app -- none of
 * these are mock-ups. `file` is the light-theme capture; `dark` is the same
 * screen in the app's dark theme.
 */
export const screenshots = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    caption:
      "Today's orders, revenue, profit, pending work and everything that needs your attention — on one screen.",
    file: 'screens/dashboard.png',
    dark: 'screens/dashboard-dark.png',
    alt: 'SellFlow dashboard showing today’s revenue and profit, money owed to you, and a list of orders needing attention.',
  },
  {
    id: 'orders',
    title: 'Orders',
    caption:
      'Every order in one queue, filtered by the exact state it is in, so nothing sits unconfirmed.',
    file: 'screens/orders.png',
    dark: 'screens/orders-dark.png',
    alt: 'SellFlow orders list filtered by fulfilment state.',
  },
  {
    id: 'order-detail',
    title: 'Order & courier tracking',
    caption:
      'The full order: what the customer owes, what it cost you, what you keep — plus live courier status and tracking.',
    file: 'screens/order-detail.png',
    dark: 'screens/order-detail-dark.png',
    alt: 'SellFlow order detail with item costs, profit, payment status and a courier tracking timeline.',
  },
  {
    id: 'products',
    title: 'Products',
    caption: 'Everything you sell, with selling price, cost price and profit per unit kept side by side.',
    file: 'screens/products.png',
    dark: 'screens/products-dark.png',
    alt: 'SellFlow products list with SKU, selling price and cost price.',
  },
  {
    id: 'product-detail',
    title: 'Products & inventory',
    caption:
      'Available, reserved and sold are tracked separately, so you never promise stock you cannot fulfil.',
    file: 'screens/product-detail.png',
    dark: 'screens/product-detail-dark.png',
    alt: 'SellFlow product detail showing available, reserved and sold quantities with cost and profit.',
  },
  {
    id: 'customers',
    title: 'Customers',
    caption: 'Your buyers, with what they have spent and what they still owe you.',
    file: 'screens/customers.png',
    dark: 'screens/customers-dark.png',
    alt: 'SellFlow customers list.',
  },
  {
    id: 'customer-detail',
    title: 'Customer detail',
    caption: 'One customer’s contact details, complete order history and outstanding balance.',
    file: 'screens/customer-detail.png',
    dark: 'screens/customer-detail-dark.png',
    alt: 'SellFlow customer detail with total spent, outstanding balance and order history.',
  },
  {
    id: 'finance',
    title: 'Finance',
    caption:
      'Sales, product cost, courier cost and expenses separated — then what is actually left as profit.',
    file: 'screens/finance.png',
    dark: 'screens/finance-dark.png',
    alt: 'SellFlow finance screen breaking down revenue, costs and profit.',
  },
  {
    id: 'analytics',
    title: 'Analytics',
    caption: 'Which products earn, which costs are growing, and how the business is trending.',
    file: 'screens/analytics.png',
    dark: 'screens/analytics-dark.png',
    alt: 'SellFlow analytics showing product performance and costs after courier and other expenses.',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    caption: 'Low stock, new orders and money movements, so you know what needs you.',
    file: 'screens/notifications.png',
    dark: 'screens/notifications-dark.png',
    alt: 'SellFlow notifications list.',
  },
  {
    id: 'order-requests',
    title: 'Customer order requests',
    caption:
      'Orders your customers submitted themselves, waiting for you to review before they become real orders.',
    file: 'screens/order-requests.png',
    dark: 'screens/order-requests-dark.png',
    alt: 'SellFlow queue of customer-submitted order requests awaiting review.',
  },
  {
    id: 'order-link',
    title: 'Customer order link',
    caption:
      'A page your customer opens on their own phone. They fill in the order; you review it before it becomes an order.',
    file: 'screens/order-link.png',
    dark: null,
    alt: 'The public order form a customer fills in from their own phone.',
  },
  {
    id: 'offline',
    title: 'Works without a signal',
    caption:
      'If your connection drops, SellFlow says so plainly and holds your changes until you are back online.',
    file: 'screens/offline.png',
    dark: null,
    alt: 'SellFlow showing an offline banner explaining that changes will sync on reconnect.',
  },
  {
    id: 'reconnected',
    title: 'Back online',
    caption: 'Reconnecting confirms what was synced, instead of leaving you to guess whether it went through.',
    file: 'screens/reconnected.png',
    dark: null,
    alt: 'SellFlow showing a confirmation banner after the connection returns and queued changes sync.',
  },
  {
    id: 'settings',
    title: 'Settings',
    caption: 'Business details, outlets, appearance, notifications and your data — all in one place.',
    file: 'screens/settings.png',
    dark: 'screens/settings-dark.png',
    alt: 'SellFlow settings screen.',
  },
  {
    id: 'login',
    title: 'Sign in',
    caption: 'Sign in to the business you are running right now.',
    file: 'screens/login.png',
    dark: null,
    alt: 'SellFlow sign-in screen.',
  },
  {
    id: 'signup',
    title: 'Create an account',
    caption: 'Register with an email and a password. No store account, no waiting.',
    file: 'screens/signup.png',
    dark: null,
    alt: 'SellFlow account registration screen.',
  },
  {
    id: 'setup',
    title: 'Business setup',
    caption:
      'Name your business and your outlet, set your timezone and currency, and the app knows how to group your days.',
    file: 'screens/setup.png',
    dark: null,
    alt: 'SellFlow business setup screen with business name, outlet and currency.',
  },
  {
    id: 'preparing',
    title: 'Getting ready',
    caption:
      'A short branded step while your first workspace loads, instead of a blank jump into the dashboard.',
    file: 'screens/preparing.png',
    dark: null,
    alt: 'SellFlow showing a branded loading state while the workspace is prepared.',
  },
  {
    id: 'appearance',
    title: 'Appearance',
    caption: 'Follow the system theme or choose light or dark yourself.',
    file: 'screens/appearance.png',
    dark: 'screens/appearance-dark.png',
    alt: 'SellFlow appearance settings for choosing light or dark theme.',
  },
];

/**
 * The commercial story. Each block names the real screens it is illustrated
 * with, so a claim can never drift away from what the app shows.
 */
export const showcases = [
  {
    id: 'know',
    kicker: 'Dashboard & alerts',
    headline: 'Know what is happening.',
    body: 'Orders, revenue, profit and the things waiting on you are all on the first screen. You open the app and immediately know where the business stands — no spreadsheet, no notes.',
    screens: ['dashboard', 'notifications'],
    align: 'left',
  },
  {
    id: 'track',
    kicker: 'Order lifecycle',
    headline: 'Never lose track of an order.',
    body: 'Every order moves through an explicit state: pending, confirmed, processing, packaging, packed, shipped, delivered. Each transition is recorded with a time, so you always know where a parcel actually is.',
    screens: ['orders', 'order-detail'],
    align: 'right',
  },
  {
    id: 'stock',
    kicker: 'Stock control',
    headline: 'Know what you actually have.',
    body: 'Available, reserved and sold are different numbers and SellFlow keeps them apart. You cannot accidentally promise stock that is already spoken for.',
    screens: ['products', 'product-detail'],
    align: 'left',
  },
  {
    id: 'finance',
    kicker: 'Finance & profit',
    headline: 'Revenue is not profit.',
    body: 'Sales, product costs, courier costs and other expenses are separated from what you keep. COD money still sitting with the courier is shown as owed to you, not as income.',
    screens: ['finance', 'analytics'],
    align: 'right',
  },
  {
    id: 'order-link',
    kicker: 'Customer order links',
    headline: 'Your customers do not need another app.',
    body: 'Send one link. Your customer fills in the order from their own phone. You review it, then turn it into a real order. Nobody installs anything.',
    screens: ['order-link', 'order-requests'],
    align: 'left',
  },
  {
    id: 'offline',
    kicker: 'Offline & sync',
    headline: 'Built for patchy signal.',
    body: 'Market signal is rarely good. SellFlow tells you plainly when you are offline, keeps your work, and confirms what synced when you reconnect.',
    screens: ['offline', 'reconnected'],
    align: 'right',
  },
];

/**
 * Feature grid. Every claim maps to shipped behaviour; anything not built is
 * described as coming later rather than implied to exist.
 */
export const features = [
  {
    icon: 'clipboard',
    title: 'Orders',
    body: 'The full lifecycle in explicit states, with a timestamped history of every change.',
  },
  {
    icon: 'box',
    title: 'Products & inventory',
    body: 'Available, reserved and sellable stock tracked separately, with a full transaction ledger.',
  },
  {
    icon: 'users',
    title: 'Customers',
    body: 'Contact details, order history, total spent and outstanding balance per customer.',
  },
  {
    icon: 'wallet',
    title: 'Finance',
    body: 'Revenue, product cost, courier cost, expenses and profit — and COD money still to collect.',
  },
  {
    icon: 'truck',
    title: 'Couriers',
    body: 'Assign a courier, record tracking, and follow the parcel status and event timeline.',
  },
  {
    icon: 'chart',
    title: 'Analytics',
    body: 'Product performance, cost breakdown and business trends, measured against your store’s day.',
  },
  {
    icon: 'cloud-off',
    title: 'Offline support',
    body: 'Keep working through a dropped connection; queued changes sync when you reconnect.',
  },
  {
    icon: 'link',
    title: 'Customer order links',
    body: 'Let customers place an order from their own phone without installing SellFlow.',
  },
  {
    icon: 'bell',
    title: 'Notifications',
    body: 'Low stock, new orders and money movements, so you know what needs your attention.',
  },
  {
    icon: 'moon',
    title: 'Light & dark',
    body: 'A finished interface in both themes, following your system or set by you.',
  },
];

/**
 * Trust section. Each point describes a property of the implementation, not a
 * claim about certifications. No security badges, no compliance language.
 */
export const trustPoints = [
  {
    title: 'Inventory is a ledger, not a number',
    body: 'Every stock movement is written as a transaction. Counting to the same figure twice changes nothing, so your stock can be explained line by line.',
  },
  {
    title: 'Money is stored in minor units',
    body: 'Amounts are held as integers and only divided for display, so rounding can never quietly change a total.',
  },
  {
    title: 'Order states cannot be skipped',
    body: 'The database refuses invalid transitions. A pending order cannot become delivered, so your history cannot tell a story that did not happen.',
  },
  {
    title: 'Your data is isolated per business',
    body: 'Every query is scoped by business and enforced by row-level security in the database, not just in the app.',
  },
  {
    title: 'Sensitive credentials are not in the app',
    body: 'The mobile app carries only a public, read-restricted key. Privileged access stays on the server.',
  },
  {
    title: 'Offline changes are queued honestly',
    body: 'Only operations that are safe to replay are queued, each with an idempotency key so a retry cannot duplicate an order.',
  },
];

export const audiences = [
  { title: 'Facebook sellers', body: 'Turning comment threads and inbox messages into real, tracked orders.' },
  { title: 'Instagram sellers', body: 'Managing DMs, orders and delivery without losing anything in a spreadsheet.' },
  { title: 'WhatsApp sellers', body: 'Taking orders over chat and keeping every one of them in one place.' },
  { title: 'TikTok sellers', body: 'Fast-moving products where stock and profit both need to stay accurate.' },
  { title: 'Home businesses', body: 'Running a real business from a phone, without dedicated staff or software.' },
  { title: 'Growing online stores', body: 'Keeping orders, stock and cash flow straight as volume grows.' },
];

export const faqs = [
  {
    q: 'What is SellFlow?',
    a: 'SellFlow is a mobile business operating system for sellers who sell through Facebook, Instagram, WhatsApp, TikTok, websites and phone orders. It brings orders, products, inventory, customers, couriers, COD payments and finance into one Android app so you can run the business from your phone.',
  },
  {
    q: 'Who is SellFlow for?',
    a: 'Sellers who are currently running their business across scattered tools — a spreadsheet for stock, notes for orders, a courier dashboard for delivery, and messages for customers. If that sounds familiar, SellFlow is built for you.',
  },
  {
    q: 'Does my customer need the SellFlow app?',
    a: 'No. Your customers never install anything. You can send them an order link and they fill in the order from their own phone. You review it, then convert it into a real order in SellFlow.',
  },
  {
    q: 'Can I use SellFlow offline?',
    a: 'Yes. If your connection drops, SellFlow shows you plainly that you are offline and keeps the work you are doing. When you reconnect it syncs those changes and tells you what went through.',
  },
  {
    q: 'Is SellFlow available on Android?',
    a: 'Yes. SellFlow V1 is an Android app. You can download the APK directly from this page. An iOS version is coming later.',
  },
  {
    q: 'How do I install the APK?',
    a: 'Download the APK from this page, open it on your Android phone, and allow installation from your browser when Android asks. That prompt appears because the APK is distributed directly rather than through Google Play.',
  },
  {
    q: 'What happens when I reconnect to the internet?',
    a: 'SellFlow shows a confirmation telling you how many changes were synced. Each queued change carries an idempotency key, so a retry after a flaky connection cannot create a duplicate order.',
  },
  {
    q: 'Does SellFlow support courier tracking?',
    a: 'Yes. You assign a courier to an order, record the tracking ID, and follow the parcel status and event timeline from the order itself. Where a courier provides status updates, they are recorded with their source so you can tell a courier update from your own.',
  },
  {
    q: 'Can I manage inventory?',
    a: 'Yes. Every product tracks available, reserved and sold stock separately. Stock movements are recorded as transactions, and you can count stock to a new figure without losing the ledger.',
  },
  {
    q: 'Can I track profit?',
    a: 'Yes. SellFlow separates sales, product cost, courier cost and other expenses so you can see what your business actually keeps. COD money that is still with the courier is shown as owed to you rather than as income.',
  },
  {
    q: 'Is SellFlow free?',
    a: 'Pricing for SellFlow has not been finalised yet. The V1 preview is free to install while we finalise it, and we will be clear about pricing before anything is charged.',
  },
  {
    q: 'Is my business data private?',
    a: 'Your records are scoped to your business and enforced by row-level security in the database. The mobile app contains only a public, read-restricted key; privileged access stays on the server and is never shipped inside the app.',
  },
];

export const changelog = [
  'Orders with an explicit, enforced lifecycle',
  'Products with available, reserved and sellable stock',
  'Customer records with order history and balances',
  'Finance: revenue, costs, expenses and profit',
  'Analytics measured against your store’s business day',
  'Courier assignment, tracking and parcel timeline',
  'Customer order links — no app required for buyers',
  'Offline queue with idempotent sync on reconnect',
  'Light and dark themes',
];

/**
 * App-store carousel tiles.
 *
 * Each tile is a short headline plus the real screen that backs it. The
 * headline is deliberately 3-5 words: a tile has about 90px of header, and a
 * sentence simply does not fit at that size.
 */
export const tiles = [
  { id: 'orders', headline: 'Every order, one queue', tint: 'blue' },
  { id: 'product-detail', headline: 'Stock you can trust', tint: 'sand' },
  { id: 'finance', headline: "Revenue isn't profit", tint: 'mint' },
  { id: 'order-detail', headline: 'Track every parcel', tint: 'slate' },
  { id: 'order-link', headline: 'No app for customers', tint: 'blue' },
  { id: 'dashboard', headline: "Today's numbers, instantly", tint: 'sand' },
  { id: 'analytics', headline: 'Answers when you ask', tint: 'mint' },
  { id: 'customers', headline: 'Everyone, accounted for', tint: 'slate' },
  { id: 'offline', headline: 'Works without signal', tint: 'blue' },
  { id: 'signup', headline: 'Ready in minutes', tint: 'sand' },
  { id: 'notifications', headline: 'Nothing falls through', tint: 'mint' },
  { id: 'settings', headline: 'Yours, your way', tint: 'slate' },
];

/**
 * "About this app" copy. Describes what the software actually does; no
 * marketing superlatives and no numbers we cannot evidence.
 */
export const about = {
  body: [
    'SellFlow is a business operating system for sellers who sell through Facebook, Instagram, WhatsApp, TikTok, websites and phone orders. It replaces the notebook, the spreadsheet and the courier dashboard with one record of what actually happened.',
    'Take an order, confirm it, pack it, hand it to a courier, follow the parcel, collect the cash and see what you kept. Each of those steps is recorded with a time, so when you ask "where is that order" or "how much am I owed" there is a real answer instead of a guess.',
    'Stock is kept as a ledger rather than a number. Available, reserved and sold are tracked separately, so you cannot accidentally promise a product you have already sold. Money is held in minor units and only divided for display, so rounding cannot quietly change a total.',
    'SellFlow is built for patchy signal. If your connection drops it tells you plainly, keeps your work, and confirms exactly what synced when you come back online.',
  ],
  /** Shown under the description, as Play shows a short summary line. */
  summary: 'Orders, stock, couriers, COD and profit, in one place.',
};

/**
 * Data safety. Every row here was checked against the code, not assumed.
 *
 * Verified: package.json has no analytics, advertising, attribution or crash
 * reporting SDK; app.json declares no Android permissions; all traffic goes to
 * Supabase over HTTPS; the app ships only a public, read-restricted API key.
 */
export const dataSafety = {
  intro:
    'SellFlow keeps your business records on your own account and does not use them for advertising. Here is exactly what is stored and who can see it.',
  shared: {
    headline: 'No data shared with third parties',
    detail: 'No analytics, advertising or attribution SDKs are included in the app.',
  },
  collected: {
    headline: 'This app collects these data types',
    detail: 'Personal info, Financial info, App activity and App info',
    /** The per-type rows, the way Play expands a data type. */
    types: [
      {
        icon: 'user',
        label: 'Personal info',
        detail: 'Customer names, phone numbers and delivery addresses you enter',
      },
      {
        icon: 'wallet',
        label: 'Financial info',
        detail: 'Order totals, payments, COD settlements and expenses',
      },
      {
        icon: 'list',
        label: 'App activity',
        detail: 'Orders, products and stock movements created in the app',
      },
      {
        icon: 'building',
        label: 'App info',
        detail: 'Your business name, outlet details and account email',
      },
    ],
  },
  notCollected: {
    headline: 'Data not collected',
    detail:
      'SellFlow does not ask for location, photos, contacts, messages or health data, and the app requests no Android permissions.',
  },
  transit: {
    headline: 'Data is encrypted in transit',
    detail: 'Every connection to the server is over HTTPS.',
  },
  control: {
    headline: 'You can request deletion',
    detail: 'Delete records in the app, or ask us to remove your account entirely.',
  },
};

/**
 * Play shows a content-rating card in the right rail. There is no Play listing
 * and therefore no official rating, so this card carries app facts that are
 * genuinely known instead of inventing a classification.
 */
export const appInfo = {
  title: 'App info',
  rows: [
    { label: 'Version', value: '1.0.0' },
    { label: 'Updated', value: '2 Oct 2026' },
    { label: 'Size', value: '~110 MB' },
    { label: 'Requires', value: 'Android 8.0+' },
    { label: 'Category', value: 'Business' },
    { label: 'Delivery', value: 'Direct APK' },
  ],
  footnote:
    'Distributed directly rather than through Google Play, so this APK is not covered by a Play Store content rating.',
};

export const channels = [
  'Facebook',
  'Instagram',
  'WhatsApp',
  'TikTok',
  'Websites',
  'Phone orders',
  'Messenger',
];