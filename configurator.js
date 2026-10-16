/*! Door configurator v1.0.0. Built from src/ by build.js. Edit src/, not this file. */
/* ==========================================================================
   ConfigEngine
   --------------------------------------------------------------------------
   Shared brain of the configurator. This exact file runs in TWO places:
     1. The website (bundled into web/configurator.js by build.js)
     2. Google Apps Script (copied to apps-script/Engine.gs by build.js)

   It does three jobs:
     - buildConfig(): turns spreadsheet rows into a clean config object and
       reports every problem in plain English (tab, row, column, how to fix).
     - evaluate(): given what a customer picked, works out which options are
       available, applies rules and stock, fixes invalid picks, prices it,
       and lists the image layers to show.
     - publicConfig(): strips private data (prices in quote-only mode, the
       quote email address) before anything is sent to a browser.

   Keep this file plain JavaScript: no import/export, no DOM, no Google
   services. Edit src/engine.js, then run `node build.js`.
   ========================================================================== */
var ConfigEngine = (function () {
  'use strict';

  /* ----------------------------------------------------------------------
     Constants (these exact words appear in Frank's dropdowns)
     ---------------------------------------------------------------------- */
  var ALL = 'All products';
  var SIZE = 'Size';
  var CUSTOM = 'Custom size';
  var STOCK = ['In stock', 'Low stock', 'Backorder', 'Out of stock'];
  var OUTPUT = {
    BOTH: 'Price and quote request',
    PRICE: 'Price only',
    QUOTE: 'Quote request only'
  };
  var SIZE_MODES = ['Standard and custom sizes', 'Standard sizes only', 'Custom sizes only'];
  var THEN = {
    HIDE: 'Hide option',
    UNAVAILABLE: 'Show option as unavailable',
    ONLY: 'Only allow option',
    HIDE_STEP: 'Hide step',
    SHOW_STEP_IF: 'Show step only if picked'
  };
  var THEN_LIST = [THEN.HIDE, THEN.UNAVAILABLE, THEN.ONLY, THEN.HIDE_STEP, THEN.SHOW_STEP_IF];
  var PRICE_TYPES = ['Fixed amount', 'Per sq ft'];
  var DISPLAYS = ['Buttons', 'Swatches', 'Dropdown'];

  function col(label, key, type, o) {
    o = o || {};
    o.label = label; o.key = key; o.type = type;
    return o;
  }

  /* ----------------------------------------------------------------------
     SETTINGS tab: one row per setting. `label` is what Frank sees.
     ---------------------------------------------------------------------- */
  var SETTINGS = [
    { key: 'outputMode', label: 'What customers see at the end', type: 'choice', choices: [OUTPUT.BOTH, OUTPUT.PRICE, OUTPUT.QUOTE], def: OUTPUT.BOTH,
      help: 'Price and quote request: shows the price and a quote form. Price only: shows the price, no form. Quote request only: hides all prices and shows the form.' },
    { key: 'currency', label: 'Currency symbol', type: 'text', def: '$', help: 'Shown before every price, like $ or CAD $.' },
    { key: 'units', label: 'Measurement units', type: 'choice', choices: ['in', 'cm'], def: 'in', help: 'Units for all widths and heights. Square footage is converted automatically.' },
    { key: 'priceNote', label: 'Note under the price', type: 'text', def: 'Estimate only. Tax, delivery, and installation are not included.', help: 'Small print shown under the total. Leave blank for none.' },
    { key: 'quoteEmail', label: 'Send quote requests to', type: 'email', def: '', help: 'Who gets an email for each quote request. Never shown on the website. Every request is also saved on the Quotes tab.' },
    { key: 'quoteSubject', label: 'Quote email subject', type: 'text', def: 'New quote request', help: 'Subject line of the email you receive.' },
    { key: 'customerCopy', label: 'Email the customer a copy', type: 'yesno', def: true, help: 'Yes sends the customer a summary of what they asked for.' },
    { key: 'publicContact', label: 'Contact info shown if something goes wrong', type: 'text', def: '', help: 'Shown to customers only if the configurator cannot load or a quote cannot be sent. Example: Call us at 555-0100.' },
    { key: 'useRules', label: 'Use option rules (Rules tab)', type: 'yesno', def: true, help: 'No turns off every rule at once without deleting them.' },
    { key: 'sizeMode', label: 'Sizes customers can pick', type: 'choice', choices: SIZE_MODES, def: SIZE_MODES[0], help: 'Standard sizes come from the Sizes tab. Custom size limits come from the Products tab.' },
    { key: 'useInventory', label: 'Use stock status', type: 'yesno', def: true, help: 'Yes shows Low stock and Backorder labels and applies the out-of-stock setting below.' },
    { key: 'outOfStock', label: 'When something is out of stock', type: 'choice', choices: ['Show it as unavailable', 'Hide it'], def: 'Show it as unavailable', help: 'Applies to options and standard sizes marked Out of stock.' },
    { key: 'showLeadTimes', label: 'Show lead times', type: 'yesno', def: true, help: 'Yes shows the Lead time text next to options and in the summary.' },
    { key: 'multiProduct', label: 'Let customers choose a product type', type: 'yesno', def: true, help: 'No shows only the Default product below.' },
    { key: 'defaultProduct', label: 'Default product', type: 'refProduct', def: '', help: 'Product shown first. Must match a name on the Products tab.' },
    { key: 'companyName', label: 'Company name', type: 'text', def: 'Your Company', help: 'Used in emails to you and to customers.' },
    { key: 'title', label: 'Configurator heading', type: 'text', def: 'Build your door', help: 'Heading at the top of the configurator. Leave blank to hide it.' },
    { key: 'accentColor', label: 'Accent color', type: 'color', def: '#2F5D50', help: 'Buttons and highlights. Use a hex code like #2F5D50.' },
    { key: 'logoUrl', label: 'Logo image (optional)', type: 'text', def: '', help: 'Full web address of a logo shown above the heading. Leave blank for none.' },
    { key: 'quoteButton', label: 'Quote button text', type: 'text', def: 'Request a quote', help: 'Text on the quote button.' }
  ];

  /* ----------------------------------------------------------------------
     DATA TABS: columns are matched by header text, so Frank can reorder
     columns or add his own note columns. `note` becomes the hover note on
     the header cell. `critical` means a bad value skips the row instead of
     falling back to the default (used for prices: a wrong price is worse
     than a missing option).
     ---------------------------------------------------------------------- */
  var TABS = {
    Products: {
      what: 'product',
      columns: [
        col('Product', 'name', 'text', { required: true, width: 170, note: 'Name customers see, like "Interior Door". Must be unique. Other tabs refer to this exact name.' }),
        col('Active', 'active', 'yesno', { def: true, width: 70, note: 'No hides this product everywhere without deleting it.' }),
        col('Description', 'description', 'text', { def: '', width: 260, note: 'One short line shown under the product name.' }),
        col('Base price', 'basePrice', 'money', { def: 0, critical: true, width: 95, note: 'Starting price before size and options. Number only, like 289 or 289.50.' }),
        col('Base image', 'image', 'image', { def: '', width: 200, note: 'Background image layer for the preview (frame, wall, etc.). Web address, or a file in the layers folder like layers/frame-interior.svg.' }),
        col('Min width', 'minW', 'dimension', { def: null, width: 85, note: 'Smallest custom width allowed. Leave the four size limits blank to turn off custom sizes for this product.' }),
        col('Max width', 'maxW', 'dimension', { def: null, width: 85, note: 'Largest custom width allowed.' }),
        col('Min height', 'minH', 'dimension', { def: null, width: 85, note: 'Smallest custom height allowed.' }),
        col('Max height', 'maxH', 'dimension', { def: null, width: 85, note: 'Largest custom height allowed.' }),
        col('Custom size step', 'stepSize', 'number', { def: 0.5, width: 110, note: 'Custom sizes must be a multiple of this. 0.5 allows 32 and 32.5 but not 32.25. Use 0 for any value.' }),
        col('Custom size price per sq ft', 'customRate', 'money', { def: 0, critical: true, width: 140, note: 'Added for custom sizes: width x height in sq ft, times this number.' }),
        col('Order', 'order', 'number', { def: 100, width: 70, note: 'Lower numbers show first.' })
      ]
    },
    Steps: {
      what: 'step',
      columns: [
        col('Product', 'product', 'refProductAll', { def: ALL, width: 150, note: 'Which product shows this step. "All products" shares it. A product-specific row with the same Step name overrides the shared one.' }),
        col('Step', 'name', 'text', { required: true, width: 150, note: 'Name of the choice the customer makes, like Style or Finish. "Size" is built in, do not add it here.' }),
        col('Active', 'active', 'yesno', { def: true, width: 70, note: 'No hides the whole step.' }),
        col('Order', 'order', 'number', { def: 100, width: 70, note: 'Lower numbers show first. Size always comes first.' }),
        col('Show options as', 'display', 'choice', { choices: DISPLAYS, def: 'Buttons', width: 120, note: 'Buttons: text buttons. Swatches: color circles (uses the Color or Swatch column). Dropdown: a compact list for long lists.' }),
        col('Required', 'required', 'yesno', { def: true, width: 85, note: 'Yes: customer must pick one. No: adds a "None" choice.' }),
        col('Color comes from', 'colorFrom', 'refStep', { def: '', width: 140, note: 'Optional. Picks which step colors this step\'s images. Example: Style images get their color from the Finish step.' }),
        col('Help text', 'help', 'text', { def: '', width: 300, note: 'One short line of guidance shown under the step name.' })
      ]
    },
    Options: {
      what: 'option',
      columns: [
        col('Product', 'product', 'refProductAll', { def: ALL, width: 150, note: 'Which product offers this option. "All products" offers it on every product that has this step.' }),
        col('Step', 'step', 'refStep', { required: true, width: 140, note: 'Which step this option belongs to. Add new steps on the Steps tab first.' }),
        col('Option', 'name', 'text', { required: true, width: 160, note: 'Name customers see, like "Natural Oak". Rules refer to this exact name.' }),
        col('Active', 'active', 'yesno', { def: true, width: 70, note: 'No hides this option without deleting it.' }),
        col('Default', 'isDefault', 'yesno', { def: false, width: 75, note: 'Yes pre-selects this option. Use Yes on one option per step.' }),
        col('Price', 'price', 'money', { def: 0, critical: true, width: 80, note: 'Added to the total. Number only. Negative numbers are discounts.' }),
        col('Price type', 'priceType', 'choice', { choices: PRICE_TYPES, def: 'Fixed amount', width: 110, note: 'Fixed amount: added once. Per sq ft: multiplied by the door area.' }),
        col('Image layer', 'image', 'image', { def: '', width: 200, note: 'Image stacked on the preview when this option is picked. All layers should be the same size with transparent backgrounds.' }),
        col('Layer order', 'layer', 'number', { def: null, width: 95, note: 'Stacking order. Higher numbers sit on top. Blank uses the step order.' }),
        col('Color', 'color', 'color', { def: '', width: 90, note: 'Hex color like #C9A46C. Tints images of steps that use "Color comes from" this step, and fills the swatch.' }),
        col('Swatch', 'swatch', 'text', { def: '', width: 120, note: 'Optional swatch override: a hex color or an image web address (wood grain photo, etc.). Blank uses Color.' }),
        col('Mirror preview', 'mirror', 'yesno', { def: false, width: 110, note: 'Yes flips the preview left to right when picked. Used for door handing.' }),
        col('Stock', 'stock', 'choice', { choices: STOCK, def: 'In stock', width: 105, note: 'Stock status. What "Out of stock" does is set on the Settings tab.' }),
        col('Lead time', 'lead', 'text', { def: '', width: 110, note: 'Free text like "2-3 weeks". Blank means none shown.' }),
        col('Description', 'description', 'text', { def: '', width: 260, note: 'Optional short detail shown on hover and in the dropdown.' })
      ]
    },
    Sizes: {
      what: 'size',
      columns: [
        col('Product', 'product', 'refProductAll', { def: ALL, width: 150, note: 'Which product offers this standard size.' }),
        col('Size name', 'name', 'text', { required: true, width: 120, note: 'Label customers see, like "30 x 80". Rules refer to this exact name.' }),
        col('Active', 'active', 'yesno', { def: true, width: 70, note: 'No hides this size.' }),
        col('Width', 'width', 'dimension', { required: true, width: 80, note: 'Width in the units set on the Settings tab.' }),
        col('Height', 'height', 'dimension', { required: true, width: 80, note: 'Height in the units set on the Settings tab.' }),
        col('Price', 'price', 'money', { def: 0, critical: true, width: 80, note: 'Added to the base price for this size. 0 for no change.' }),
        col('Stock', 'stock', 'choice', { choices: STOCK, def: 'In stock', width: 105, note: 'Stock status for this size.' }),
        col('Lead time', 'lead', 'text', { def: '', width: 110, note: 'Free text like "3-5 weeks".' })
      ]
    },
    Rules: {
      what: 'rule',
      columns: [
        col('Active', 'active', 'yesno', { def: true, width: 70, note: 'No switches this rule off.' }),
        col('Product', 'product', 'refProductAll', { def: ALL, width: 150, note: 'Which product this rule applies to.' }),
        col('When step', 'whenStep', 'refStepOrSize', { required: true, width: 130, note: 'The step the customer picks in. Use "Size" for sizes.' }),
        col('Is', 'whenOption', 'text', { required: true, width: 150, note: 'The exact option name (or size name, or "Custom size") that triggers this rule.' }),
        col('Then', 'then', 'choice', { choices: THEN_LIST, required: true, width: 190, note: 'Hide option: removes it. Show option as unavailable: greyed out with your message. Only allow option: hides every other option in that step (add one row per allowed option). Hide step: removes a whole step. Show step only if picked: the step stays hidden unless this condition is true.' }),
        col('Target step', 'targetStep', 'refStepOrSize', { required: true, width: 130, note: 'The step that is affected.' }),
        col('Target option', 'targetOption', 'text', { def: '', width: 150, note: 'The exact option name affected. Leave blank for "Hide step" and "Show step only if picked".' }),
        col('Message to customer', 'message', 'text', { def: '', width: 300, note: 'Optional. Explains why, like "Custom sizes ship primed." Shown when something is unavailable or changed.' })
      ]
    }
  };
  var TAB_ORDER = ['Settings', 'Products', 'Steps', 'Options', 'Sizes', 'Rules'];
  var REQUIRED_TABS = { Settings: true, Products: true, Steps: true, Options: true };

  /* ----------------------------------------------------------------------
     Small helpers
     ---------------------------------------------------------------------- */
  function lc(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
  function isBlank(v) { return v === null || v === undefined || (typeof v === 'string' && v.trim() === ''); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function sentence(s) { s = String(s || '').trim(); return s && !/[.!?]$/.test(s) ? s + '.' : s; }
  function quote(s) { return '"' + s + '"'; }

  // Edit distance, used for "Did you mean ...?" suggestions.
  function lev(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    if (!m) return n; if (!n) return m;
    for (i = 0; i <= m; i++) d[i] = [i];
    for (j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[m][n];
  }
  function suggest(input, list) {
    var a = lc(input), best = null, bestD = Infinity;
    if (!a) return null;
    (list || []).forEach(function (c) {
      var b = lc(c); if (!b) return;
      var d = lev(a, b);
      if (b.indexOf(a) === 0 || a.indexOf(b) === 0) d = Math.min(d, 1);
      if (d < bestD) { bestD = d; best = c; }
    });
    return bestD <= Math.max(2, Math.floor(a.length / 3)) ? best : null;
  }
  function didYouMean(input, list) {
    var s = suggest(input, list);
    return s ? ' Did you mean ' + quote(s) + '?' : '';
  }
  function listText(arr) { return arr.map(quote).join(', '); }
  function findByName(list, name) {
    var k = lc(name);
    if (!k) return null;
    for (var i = 0; i < list.length; i++) if (lc(list[i].name) === k) return list[i];
    return null;
  }

  /* ----------------------------------------------------------------------
     Problems collector. Levels:
       fatal   - the configurator cannot load at all
       error   - a row was skipped
       warning - something was ignored or a default was used
     ---------------------------------------------------------------------- */
  function Problems() { this.list = []; }
  Problems.prototype.add = function (level, tab, row, column, message, fix) {
    this.list.push({ level: level, tab: tab || '', row: row || null, column: column || '', message: message, fix: fix || '' });
  };
  Problems.prototype.has = function (level) {
    return this.list.some(function (p) { return p.level === level; });
  };

  /* ----------------------------------------------------------------------
     Cell parsing: returns { value } or { bad: {message, fix} }
     ---------------------------------------------------------------------- */
  function parseValue(raw, c) {
    if (isBlank(raw)) {
      if (c.required) return { bad: { message: quote(c.label) + ' is empty.', fix: 'Fill in ' + c.label + ', or set Active to No to park this row.' }, blank: true };
      return { value: c.def === undefined ? '' : c.def };
    }
    var s = typeof raw === 'string' ? raw.trim() : raw;
    switch (c.type) {
      case 'yesno': {
        if (raw === true || raw === false) return { value: raw };
        var y = lc(s);
        if (['yes', 'y', 'true', '1', 'on'].indexOf(y) >= 0) return { value: true };
        if (['no', 'n', 'false', '0', 'off'].indexOf(y) >= 0) return { value: false };
        return { bad: { message: quote(raw) + ' is not Yes or No.', fix: 'Pick Yes or No from the dropdown.' } };
      }
      case 'money':
      case 'number':
      case 'dimension': {
        var n;
        if (typeof raw === 'number') n = raw;
        else {
          var cleaned = String(s).replace(/[$€£,\s]/g, '').replace(/^(usd|cad|eur|gbp)/i, '');
          n = /^-?(\d+\.?\d*|\.\d+)$/.test(cleaned) ? parseFloat(cleaned) : NaN;
        }
        if (!isFinite(n)) {
          return { bad: { message: quote(raw) + ' is not a number.', fix: 'Type a number only, like 12 or 12.50. No words or units.' } };
        }
        if (c.type === 'dimension' && n <= 0) return { bad: { message: c.label + ' must be greater than 0 (it is ' + n + ').', fix: 'Type a size larger than 0.' } };
        if (c.type === 'number' && n < 0) return { bad: { message: c.label + ' cannot be negative (it is ' + n + ').', fix: 'Type 0 or a positive number.' } };
        return { value: n };
      }
      case 'choice': {
        for (var i = 0; i < c.choices.length; i++) if (lc(c.choices[i]) === lc(s)) return { value: c.choices[i] };
        return { bad: { message: quote(raw) + ' is not one of the choices for ' + c.label + '.' + didYouMean(s, c.choices), fix: 'Pick from the dropdown: ' + listText(c.choices) + '.' } };
      }
      case 'color': {
        var h = String(s).replace(/^#/, '');
        if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/(.)/g, '$1$1');
        if (/^[0-9a-f]{6}$/i.test(h)) return { value: '#' + h.toUpperCase() };
        return { bad: { message: quote(raw) + ' is not a color code.', fix: 'Use a hex color code like #C9A46C. Any online color picker shows this code.' } };
      }
      case 'email': {
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s))) return { value: String(s) };
        return { bad: { message: quote(raw) + ' does not look like an email address.', fix: 'Use a full address like name@company.com.' } };
      }
      default:
        return { value: String(s) };
    }
  }
  function defaultText(c) {
    if (c.def === true) return 'Yes';
    if (c.def === false) return 'No';
    if (c.def === null || c.def === '' || c.def === undefined) return 'blank';
    return String(c.def);
  }

  /* ----------------------------------------------------------------------
     Read one data tab into row objects (with _row = sheet row number).
     Returns null if the tab cannot be used at all.
     ---------------------------------------------------------------------- */
  function readTab(tables, tabName, P) {
    var schema = TABS[tabName];
    var grid = tables[tabName];
    var required = !!REQUIRED_TABS[tabName];
    if (!grid) {
      var near = suggest(tabName, tables._tabNames || []);
      P.add(required ? 'fatal' : 'warning', tabName, null, '',
        'The ' + quote(tabName) + ' tab is missing.' + (near ? ' There is a tab called ' + quote(near) + '.' : '') + (required ? '' : ' Continuing without it.'),
        near ? 'Rename the ' + quote(near) + ' tab back to ' + quote(tabName) + ' (exact spelling), or run Configurator > Set up / repair sheet.'
          : 'Run Configurator > Set up / repair sheet to recreate it.');
      return required ? null : [];
    }
    var header = (grid[0] || []).map(function (h) { return String(h == null ? '' : h).trim(); });
    var idx = {}, ok = true;
    schema.columns.forEach(function (c) {
      var i = -1;
      header.forEach(function (h, j) { if (i < 0 && lc(h) === lc(c.label)) i = j; });
      idx[c.key] = i;
      if (i < 0) {
        var taken = header.filter(function (h) {
          return h && !schema.columns.some(function (x) { return lc(x.label) === lc(h); });
        });
        var near = suggest(c.label, taken);
        var msg = 'The ' + quote(c.label) + ' column is missing.' + (near ? ' There is a column called ' + quote(near) + '. Was it renamed?' : '');
        var fix = near ? 'Rename ' + quote(near) + ' back to ' + quote(c.label) + ' (exact spelling), or run Configurator > Set up / repair sheet.'
          : 'Run Configurator > Set up / repair sheet to add it back.';
        if (c.required) { P.add(required ? 'fatal' : 'error', tabName, 1, c.label, msg + (required ? '' : ' The whole tab is being ignored.'), fix); ok = false; }
        else P.add('warning', tabName, 1, c.label, msg + ' Using ' + quote(defaultText(c)) + ' for every row.', fix);
      }
    });
    if (!ok) return required ? null : [];

    var rows = [];
    rows.skipped = [];
    for (var r = 1; r < grid.length; r++) {
      var cells = grid[r] || [];
      var rowNum = r + 1;
      var allBlank = schema.columns.every(function (c) { return idx[c.key] < 0 || isBlank(cells[idx[c.key]]); });
      if (allBlank) continue;

      // Inactive rows are skipped before any checks, so Frank can park
      // half-finished rows by setting Active to No.
      var activeCol = schema.columns.filter(function (c) { return c.key === 'active'; })[0];
      if (activeCol && idx.active >= 0) {
        var a = parseValue(cells[idx.active], activeCol);
        if (!a.bad && a.value === false) continue;
      }

      var obj = { _row: rowNum }, skip = false;
      schema.columns.forEach(function (c) {
        var raw = idx[c.key] >= 0 ? cells[idx[c.key]] : '';
        var res = parseValue(raw, c);
        if (res.bad) {
          if (c.required || c.critical) {
            P.add('error', tabName, rowNum, c.label, res.bad.message + ' This ' + schema.what + ' is being skipped.', res.bad.fix);
            skip = true;
          } else {
            P.add('warning', tabName, rowNum, c.label, res.bad.message + ' Using ' + quote(defaultText(c)) + ' instead.', res.bad.fix);
            obj[c.key] = c.def;
          }
        } else obj[c.key] = res.value;
      });
      if (!skip) rows.push(obj);
      else rows.skipped.push({ name: idx.name >= 0 ? String(cells[idx.name] || '').trim() : '', row: rowNum });
    }
    return rows;
  }

  /* ----------------------------------------------------------------------
     Settings tab: label/value pairs.
     ---------------------------------------------------------------------- */
  function readSettings(tables, P) {
    var S = {};
    SETTINGS.forEach(function (s) { S[s.key] = s.def; });
    var grid = tables.Settings;
    if (!grid) {
      P.add('fatal', 'Settings', null, '', 'The "Settings" tab is missing.' + (suggest('Settings', tables._tabNames || []) ? ' There is a tab called ' + quote(suggest('Settings', tables._tabNames)) + '.' : ''),
        'Rename it back to "Settings" or run Configurator > Set up / repair sheet.');
      return null;
    }
    var header = (grid[0] || []).map(function (h) { return lc(h); });
    var ki = header.indexOf('setting'), vi = header.indexOf('value');
    if (ki < 0 || vi < 0) {
      P.add('fatal', 'Settings', 1, ki < 0 ? 'Setting' : 'Value', 'The Settings tab needs a "Setting" column and a "Value" column in the first row.',
        'Put "Setting" and "Value" back in row 1, or run Configurator > Set up / repair sheet.');
      return null;
    }
    var seen = {};
    S._rows = {};
    var labels = SETTINGS.map(function (s) { return s.label; });
    for (var r = 1; r < grid.length; r++) {
      var label = String(grid[r][ki] == null ? '' : grid[r][ki]).trim();
      if (!label) continue;
      var def = null;
      SETTINGS.forEach(function (s) { if (lc(s.label) === lc(label)) def = s; });
      if (!def) {
        P.add('warning', 'Settings', r + 1, 'Setting', 'Unknown setting ' + quote(label) + ' is being ignored.' + didYouMean(label, labels),
          'Fix the spelling or delete the row. The Help tab lists every setting.');
        continue;
      }
      seen[def.key] = true;
      S._rows[def.key] = r + 1;
      var c = { label: def.label, type: def.type === 'refProduct' ? 'text' : def.type, choices: def.choices, def: def.def };
      var res = parseValue(grid[r][vi], c);
      if (res.bad) {
        P.add('warning', 'Settings', r + 1, 'Value', def.label + ': ' + res.bad.message + ' Using ' + quote(defaultText(c)) + ' instead.', res.bad.fix);
      } else S[def.key] = res.value;
    }
    SETTINGS.forEach(function (s) {
      if (!seen[s.key]) P.add('warning', 'Settings', null, 'Setting', 'The setting ' + quote(s.label) + ' is missing. Using ' + quote(defaultText(s)) + '.',
        'Run Configurator > Set up / repair sheet to add it back.');
    });
    return S;
  }

  /* ----------------------------------------------------------------------
     buildConfig: spreadsheet rows -> config + problems
     tables = { Settings: [[...],[...]], Products: [...], ..., _tabNames: [...] }
     ---------------------------------------------------------------------- */
  function buildConfig(tables) {
    var P = new Problems();
    tables = tables || {};
    var S = readSettings(tables, P);
    var products = readTab(tables, 'Products', P);
    var steps = readTab(tables, 'Steps', P);
    var options = readTab(tables, 'Options', P);
    var sizes = readTab(tables, 'Sizes', P) || [];
    var rules = readTab(tables, 'Rules', P) || [];
    if (!S || !products || !steps || !options) return { config: null, problems: P.list, fatal: true };

    // Names on rows that were skipped, so later messages can point at the
    // real cause instead of saying "does not exist".
    var skipped = { option: {}, size: {} };
    (options.skipped || []).forEach(function (x) { if (x.name) skipped.option[lc(x.name)] = x.row; });
    (sizes.skipped || []).forEach(function (x) { if (x.name) skipped.size[lc(x.name)] = x.row; });

    /* ---- Products ---- */
    var pSeen = {}, pList = [];
    products.forEach(function (p) {
      var k = lc(p.name);
      if (k === lc(ALL)) { P.add('error', 'Products', p._row, 'Product', quote(ALL) + ' is reserved and cannot be a product name. This product is being skipped.', 'Rename the product.'); return; }
      if (pSeen[k]) { P.add('error', 'Products', p._row, 'Product', 'The product name ' + quote(p.name) + ' is already used on row ' + pSeen[k]._row + '. This duplicate is being skipped.', 'Give each product a different name.'); return; }
      pSeen[k] = p;
      if (p.basePrice < 0) P.add('warning', 'Products', p._row, 'Base price', 'Base price is negative (' + p.basePrice + ').', 'Use 0 or more.');
      // Custom size limits
      var lim = [p.minW, p.maxW, p.minH, p.maxH];
      var filled = lim.filter(function (x) { return x !== null && x !== '' && x !== undefined; }).length;
      p.custom = filled === 4;
      if (filled > 0 && filled < 4) {
        p.custom = false;
        P.add('warning', 'Products', p._row, 'Min width', 'Custom sizes are off for ' + quote(p.name) + ' because some size limits are blank.', 'Fill in all four of Min width, Max width, Min height, Max height (or clear all four).');
      }
      if (p.custom && p.minW > p.maxW) { p.custom = false; P.add('error', 'Products', p._row, 'Min width', 'Min width (' + p.minW + ') is larger than Max width (' + p.maxW + '). Custom sizes are off for ' + quote(p.name) + '.', 'Swap the two numbers.'); }
      if (p.custom && p.minH > p.maxH) { p.custom = false; P.add('error', 'Products', p._row, 'Min height', 'Min height (' + p.minH + ') is larger than Max height (' + p.maxH + '). Custom sizes are off for ' + quote(p.name) + '.', 'Swap the two numbers.'); }
      if (!p.custom && filled === 0 && S.sizeMode !== SIZE_MODES[1]) {
        P.add('warning', 'Products', p._row, 'Min width', 'No custom size limits for ' + quote(p.name) + ', so customers can only pick standard sizes for it.', 'Fill in Min/Max width and height to allow custom sizes.');
      }
      pList.push(p);
    });
    pList.sort(function (a, b) { return (a.order - b.order) || (a._row - b._row); });
    if (!pList.length) {
      P.add('fatal', 'Products', null, 'Product', 'There are no active products, so there is nothing to configure.', 'Add a product on the Products tab, or set Active to Yes on one.');
      return { config: null, problems: P.list, fatal: true };
    }
    var pNames = pList.map(function (p) { return p.name; });
    function checkProduct(tab, row, value) {
      if (lc(value) === lc(ALL)) return ALL;
      var hit = findByName(pList, value);
      if (hit) return hit.name;
      P.add('error', tab, row, 'Product', 'Product ' + quote(value) + ' does not exist (or is not active) on the Products tab.' + didYouMean(value, pNames) + ' This row is being skipped.',
        'Pick a product from the dropdown, or "' + ALL + '".');
      return null;
    }

    if (S.defaultProduct && !findByName(pList, S.defaultProduct)) {
      P.add('warning', 'Settings', S._rows.defaultProduct, 'Value', 'Default product ' + quote(S.defaultProduct) + ' is not an active product. Using ' + quote(pList[0].name) + '.' + didYouMean(S.defaultProduct, pNames),
        'Pick a product from the dropdown on the Settings tab.');
      S.defaultProduct = pList[0].name;
    }
    if (!S.defaultProduct) S.defaultProduct = pList[0].name;
    else S.defaultProduct = findByName(pList, S.defaultProduct).name;

    /* ---- Steps ---- */
    var sList = [], sSeen = {}, stepNames = {};
    steps.forEach(function (s, i) {
      if (lc(s.name) === lc(SIZE)) { P.add('error', 'Steps', s._row, 'Step', '"Size" is built in and cannot be added as a step. This row is being skipped.', 'Delete this row. Sizes are set on the Sizes and Products tabs.'); return; }
      var prod = checkProduct('Steps', s._row, s.product); if (!prod) return;
      s.product = prod;
      var key = lc(prod) + '|' + lc(s.name);
      if (sSeen[key]) { P.add('warning', 'Steps', s._row, 'Step', 'Step ' + quote(s.name) + ' for ' + quote(prod) + ' is listed twice (also row ' + sSeen[key]._row + '). This row is ignored.', 'Delete one of the two rows.'); return; }
      sSeen[key] = s;
      s.idx = i;
      if (!stepNames[lc(s.name)]) stepNames[lc(s.name)] = s.name;
      sList.push(s);
    });
    var allStepNames = Object.keys(stepNames).map(function (k) { return stepNames[k]; });
    sList.forEach(function (s) {
      if (s.colorFrom) {
        if (!stepNames[lc(s.colorFrom)]) {
          P.add('warning', 'Steps', s._row, 'Color comes from', 'Step ' + quote(s.colorFrom) + ' does not exist, so ' + quote(s.name) + ' images will not be tinted.' + didYouMean(s.colorFrom, allStepNames), 'Pick a step from the dropdown or clear the cell.');
          s.colorFrom = '';
        } else s.colorFrom = stepNames[lc(s.colorFrom)];
      }
    });
    function stepExistsFor(stepName, product) {
      return sList.some(function (s) {
        return lc(s.name) === lc(stepName) && (product === ALL || s.product === ALL || lc(s.product) === lc(product));
      });
    }

    /* ---- Options ---- */
    var oList = [], oSeen = {};
    options.forEach(function (o, i) {
      var prod = checkProduct('Options', o._row, o.product);
      if (!prod) { skipped.option[lc(o.name)] = o._row; return; }
      o.product = prod;
      if (!stepNames[lc(o.step)]) {
        P.add('error', 'Options', o._row, 'Step', 'Step ' + quote(o.step) + ' is not on the Steps tab.' + didYouMean(o.step, allStepNames) + ' Option ' + quote(o.name) + ' is being skipped.',
          'Pick a step from the dropdown, or add ' + quote(o.step) + ' on the Steps tab first.');
        skipped.option[lc(o.name)] = o._row;
        return;
      }
      o.step = stepNames[lc(o.step)];
      if (!stepExistsFor(o.step, prod)) {
        P.add('warning', 'Options', o._row, 'Product', 'Option ' + quote(o.name) + ' is for ' + quote(prod) + ', but the ' + quote(o.step) + ' step is not set up for that product, so it will never show.',
          'On the Steps tab, set ' + quote(o.step) + ' to ' + quote(prod) + ' or "' + ALL + '".');
      }
      var key = lc(prod) + '|' + lc(o.step) + '|' + lc(o.name);
      if (oSeen[key]) {
        P.add('warning', 'Options', o._row, 'Option', quote(o.name) + ' is listed twice in ' + quote(o.step) + ' for ' + quote(prod) + ' (also row ' + oSeen[key]._row + '). This row is ignored.', 'Delete one of the two rows or rename one.');
        return;
      }
      oSeen[key] = o;
      if (lc(o.name) === 'none') P.add('warning', 'Options', o._row, 'Option', '"None" is added automatically to optional steps. Naming an option "None" may confuse customers.', 'Rename it, or set the step\'s Required to No and delete this row.');
      if (o.image && !/^(https?:|data:|\/)/i.test(o.image) && !/\.(svg|png|jpe?g|webp|gif|avif)(\?.*)?$/i.test(o.image)) {
        P.add('warning', 'Options', o._row, 'Image layer', quote(o.image) + ' does not look like an image file.', 'Use a full web address or a file path ending in .png, .svg, .jpg or .webp.');
      }
      if (o.swatch && !/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(o.swatch) && !/^(https?:|data:|\/)/i.test(o.swatch) && !/\.(svg|png|jpe?g|webp)$/i.test(o.swatch)) {
        P.add('warning', 'Options', o._row, 'Swatch', quote(o.swatch) + ' is not a color code or an image address. Using Color instead.', 'Use a hex code like #C9A46C or an image web address.');
        o.swatch = '';
      } else if (/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(o.swatch)) o.swatch = '#' + o.swatch;
      o.idx = i;
      oList.push(o);
    });

    /* ---- Sizes ---- */
    var zList = [], zSeen = {};
    sizes.forEach(function (z, i) {
      var prod = checkProduct('Sizes', z._row, z.product);
      if (!prod) { skipped.size[lc(z.name)] = z._row; return; }
      z.product = prod;
      if (lc(z.name) === lc(CUSTOM)) { P.add('error', 'Sizes', z._row, 'Size name', quote(CUSTOM) + ' is reserved. This size is being skipped.', 'Rename this size, like "36 x 84".'); return; }
      var key = lc(prod) + '|' + lc(z.name);
      if (zSeen[key]) { P.add('warning', 'Sizes', z._row, 'Size name', 'Size ' + quote(z.name) + ' is listed twice for ' + quote(prod) + ' (also row ' + zSeen[key]._row + '). This row is ignored.', 'Delete one of the two rows.'); return; }
      zSeen[key] = z;
      z.idx = i;
      zList.push(z);
    });

    /* ---- Rules ---- */
    var rList = [];
    function namesInStep(stepName) {
      if (lc(stepName) === lc(SIZE)) return zList.map(function (z) { return z.name; }).concat([CUSTOM]);
      return oList.filter(function (o) { return lc(o.step) === lc(stepName); }).map(function (o) { return o.name; });
    }
    function missingName(name, stepName, names, column, rowNum) {
      var isSize = stepName === SIZE;
      var sk = (isSize ? skipped.size : skipped.option)[lc(name)];
      if (sk) {
        P.add('error', 'Rules', rowNum, column, quote(name) + ' cannot be used because its row on the ' + (isSize ? 'Sizes' : 'Options') + ' tab (row ' + sk + ') has a problem. This rule is being skipped.',
          'Fix row ' + sk + ' on the ' + (isSize ? 'Sizes' : 'Options') + ' tab first. This rule will start working once it is fixed.');
      } else {
        P.add('error', 'Rules', rowNum, column, quote(name) + ' is not an option in ' + quote(stepName) + '.' + didYouMean(name, names) + ' This rule is being skipped.',
          'Type the option name exactly as it appears on the ' + (isSize ? 'Sizes tab (or "Custom size")' : 'Options tab') + '.');
      }
    }
    function canonStep(name) { return lc(name) === lc(SIZE) ? SIZE : stepNames[lc(name)]; }
    rules.forEach(function (r) {
      var prod = checkProduct('Rules', r._row, r.product); if (!prod) return;
      r.product = prod;
      var stepChoices = [SIZE].concat(allStepNames);
      var ws = canonStep(r.whenStep);
      if (!ws) { P.add('error', 'Rules', r._row, 'When step', 'Step ' + quote(r.whenStep) + ' does not exist.' + didYouMean(r.whenStep, stepChoices) + ' This rule is being skipped.', 'Pick a step from the dropdown.'); return; }
      r.whenStep = ws;
      var wNames = namesInStep(ws);
      var wHit = wNames.filter(function (n) { return lc(n) === lc(r.whenOption); })[0];
      if (!wHit) { missingName(r.whenOption, ws, wNames, 'Is', r._row); return; }
      r.whenOption = wHit;
      var ts = canonStep(r.targetStep);
      if (!ts) { P.add('error', 'Rules', r._row, 'Target step', 'Step ' + quote(r.targetStep) + ' does not exist.' + didYouMean(r.targetStep, stepChoices) + ' This rule is being skipped.', 'Pick a step from the dropdown.'); return; }
      r.targetStep = ts;
      var stepLevel = r.then === THEN.HIDE_STEP || r.then === THEN.SHOW_STEP_IF;
      if (stepLevel) {
        if (ts === SIZE) { P.add('error', 'Rules', r._row, 'Target step', 'The Size step cannot be hidden. This rule is being skipped.', 'Target a different step, or hide individual sizes with "Hide option".'); return; }
        if (r.targetOption) P.add('warning', 'Rules', r._row, 'Target option', quote(r.then) + ' affects the whole step, so Target option is ignored.', 'Clear the Target option cell.');
        r.targetOption = '';
      } else {
        if (!r.targetOption) { P.add('error', 'Rules', r._row, 'Target option', quote(r.then) + ' needs a Target option. This rule is being skipped.', 'Type the option name to ' + (r.then === THEN.ONLY ? 'allow' : 'affect') + '.'); return; }
        var tNames = namesInStep(ts);
        var tHit = tNames.filter(function (n) { return lc(n) === lc(r.targetOption); })[0];
        if (!tHit) { missingName(r.targetOption, ts, tNames, 'Target option', r._row); return; }
        r.targetOption = tHit;
      }
      if (ws === ts && !stepLevel) P.add('warning', 'Rules', r._row, 'Target step', 'This rule targets the same step it watches (' + quote(ws) + '). It will rarely do anything useful.', 'Check that When step and Target step are right.');
      rList.push(r);
    });
    if (!S.useRules && rList.length) P.add('warning', 'Settings', S._rows.useRules, 'Value', 'Option rules are switched off on the Settings tab, so the ' + rList.length + ' rule(s) on the Rules tab are not used.', 'Set "Use option rules (Rules tab)" to Yes to turn them on.');

    /* ---- Cross checks ---- */
    sList.forEach(function (s) {
      var has = oList.some(function (o) {
        return lc(o.step) === lc(s.name) && (s.product === ALL || o.product === ALL || lc(o.product) === lc(s.product));
      });
      if (!has) P.add('warning', 'Steps', s._row, 'Step', 'Step ' + quote(s.name) + ' has no active options, so customers will not see it.', 'Add options for it on the Options tab, or set this step to Active No.');
    });
    pList.forEach(function (p) {
      var std = zList.some(function (z) { return z.product === ALL || lc(z.product) === lc(p.name); });
      var canCustom = p.custom && S.sizeMode !== SIZE_MODES[1];
      var canStd = std && S.sizeMode !== SIZE_MODES[2];
      if (!canCustom && !canStd) {
        P.add('error', 'Products', p._row, 'Product', 'Customers cannot pick any size for ' + quote(p.name) + ' with the current settings, so they cannot finish.',
          S.sizeMode === SIZE_MODES[2] ? 'Fill in the custom size limits for this product, or change "Sizes customers can pick".'
            : 'Add standard sizes for this product on the Sizes tab' + (S.sizeMode === SIZE_MODES[1] ? ', or change "Sizes customers can pick".' : ', or fill in its custom size limits.'));
      }
    });
    if (S.outputMode !== OUTPUT.PRICE && !S.quoteEmail) {
      P.add('warning', 'Settings', S._rows.quoteEmail, 'Value', 'No email address is set for quote requests. Requests will only be saved on the Quotes tab.', 'Fill in "Send quote requests to" on the Settings tab.');
    }

    var config = {
      version: 1,
      generatedAt: new Date().toISOString(),
      settings: S,
      products: pList.map(function (p) {
        return { name: p.name, description: p.description, basePrice: p.basePrice, image: p.image, custom: p.custom,
          minW: p.minW, maxW: p.maxW, minH: p.minH, maxH: p.maxH, stepSize: p.stepSize, customRate: p.customRate, _row: p._row };
      }),
      steps: sList.map(function (s) {
        return { product: s.product, name: s.name, order: s.order, display: s.display, required: s.required, colorFrom: s.colorFrom, help: s.help, idx: s.idx, _row: s._row };
      }),
      options: oList.map(function (o) {
        return { product: o.product, step: o.step, name: o.name, isDefault: o.isDefault, price: o.price, priceType: o.priceType, image: o.image,
          layer: o.layer, color: o.color, swatch: o.swatch, mirror: o.mirror, stock: o.stock, lead: o.lead, description: o.description, idx: o.idx, _row: o._row };
      }),
      sizes: zList.map(function (z) {
        return { product: z.product, name: z.name, width: z.width, height: z.height, price: z.price, stock: z.stock, lead: z.lead, idx: z.idx, _row: z._row };
      }),
      rules: rList.map(function (r) {
        return { product: r.product, whenStep: r.whenStep, whenOption: r.whenOption, then: r.then, targetStep: r.targetStep, targetOption: r.targetOption, message: r.message, _row: r._row };
      })
    };
    return { config: config, problems: P.list, fatal: false };
  }

  /* ----------------------------------------------------------------------
     publicConfig: what is safe to send to a browser.
     ---------------------------------------------------------------------- */
  function publicConfig(cfg) {
    var c = JSON.parse(JSON.stringify(cfg));
    delete c.settings.quoteEmail;
    delete c.settings.quoteSubject;
    delete c.settings.customerCopy;
    if (c.settings.outputMode === OUTPUT.QUOTE) {
      c.pricesStripped = true;
      c.products.forEach(function (p) { p.basePrice = null; p.customRate = null; });
      c.options.forEach(function (o) { o.price = null; });
      c.sizes.forEach(function (z) { z.price = null; });
    }
    // Row numbers (_row) are kept so the website can say exactly which
    // sheet row has a broken image when debug mode is on.
    return c;
  }

  /* ----------------------------------------------------------------------
     evaluate: what can the customer pick right now, and what does it cost?

     input = {
       product: 'Interior Door',
       size: { type: 'standard', name: '30 x 80' } or { type: 'custom', width: 32, height: 80 },
       selections: { Style: 'Shaker', Finish: 'Natural Oak', Hardware: null }  // null = "None"
     }
     Missing selections get the default. Invalid ones are replaced and
     explained in `notices`.
     ---------------------------------------------------------------------- */
  var RANK = { ok: 0, unavailable: 1, hidden: 2 };

  function evaluate(cfg, input) {
    input = input || {};
    var S = cfg.settings;
    var showPrices = S.outputMode !== OUTPUT.QUOTE && !cfg.pricesStripped;
    var notices = [];

    // Product
    var def = findByName(cfg.products, S.defaultProduct) || cfg.products[0];
    var productList = S.multiProduct ? cfg.products : [def];
    var product = findByName(productList, input.product) || def;
    var pk = lc(product.name);
    function applies(x) { return x.product === ALL || lc(x.product) === pk; }

    // Steps for this product (a product-specific row overrides a shared one)
    var stepMap = {};
    cfg.steps.forEach(function (s) {
      if (!applies(s)) return;
      var k = lc(s.name), ex = stepMap[k];
      if (ex && (ex.product !== ALL || s.product === ALL)) return;
      stepMap[k] = s;
    });
    var steps = Object.keys(stepMap).map(function (k) { return stepMap[k]; })
      .sort(function (a, b) { return (a.order - b.order) || (a.idx - b.idx); });
    var optsByStep = {};
    steps.forEach(function (s) {
      optsByStep[lc(s.name)] = cfg.options.filter(function (o) { return applies(o) && lc(o.step) === lc(s.name); })
        .sort(function (a, b) { return a.idx - b.idx; });
    });
    var sizes = cfg.sizes.filter(applies).sort(function (a, b) { return a.idx - b.idx; });
    var rules = S.useRules ? cfg.rules.filter(applies) : [];
    var allowStdBase = S.sizeMode !== SIZE_MODES[2] && sizes.length > 0;
    var allowCustomBase = S.sizeMode !== SIZE_MODES[1] && !!product.custom;

    // Selections, keyed by canonical step name
    var sel = {};
    var inSel = input.selections || {};
    Object.keys(inSel).forEach(function (k) {
      var s = stepMap[lc(k)];
      if (s) sel[s.name] = inSel[k] === null ? null : (inSel[k] === undefined ? undefined : String(inSel[k]));
    });

    // Size
    var size = { type: null, name: null, width: '', height: '' };
    if (input.size) {
      size.type = input.size.type === 'custom' ? 'custom' : 'standard';
      size.name = input.size.name || null;
      size.width = input.size.width == null ? '' : input.size.width;
      size.height = input.size.height == null ? '' : input.size.height;
    }

    function selLc(stepName) {
      var s = stepMap[lc(stepName)];
      return s ? lc(sel[s.name]) : '';
    }
    function met(r) {
      if (r.whenStep === SIZE) {
        if (lc(r.whenOption) === lc(CUSTOM)) return size.type === 'custom';
        return size.type === 'standard' && lc(size.name) === lc(r.whenOption);
      }
      return selLc(r.whenStep) === lc(r.whenOption);
    }
    function ruleEffects() {
      var fx = { opt: {}, only: {}, hideStep: {}, gate: {} };
      rules.forEach(function (r) {
        var tk = lc(r.targetStep);
        if (r.then === THEN.SHOW_STEP_IF) {
          fx.gate[tk] = fx.gate[tk] || { any: false };
          if (met(r)) fx.gate[tk].any = true;
          return;
        }
        if (!met(r)) return;
        if (r.then === THEN.HIDE_STEP) { fx.hideStep[tk] = true; return; }
        var ok = lc(r.targetOption);
        if (r.then === THEN.ONLY) {
          fx.only[tk] = fx.only[tk] || { set: {}, msg: '' };
          fx.only[tk].set[ok] = true;
          if (r.message) fx.only[tk].msg = r.message;
          return;
        }
        var m = fx.opt[tk] = fx.opt[tk] || {};
        var level = r.then === THEN.HIDE ? 'hidden' : 'unavailable';
        if (!m[ok] || RANK[level] > RANK[m[ok].status]) m[ok] = { status: level, reason: r.message || '' };
      });
      return fx;
    }
    function statusFor(item, stepKey, fx) {
      var st = { status: 'ok', reason: '' };
      if (S.useInventory && item.stock === 'Out of stock') {
        st = { status: S.outOfStock === 'Hide it' ? 'hidden' : 'unavailable', reason: 'Out of stock' };
      }
      var e = fx.opt[stepKey] && fx.opt[stepKey][lc(item.name)];
      if (e && RANK[e.status] > RANK[st.status]) st = { status: e.status, reason: e.reason };
      else if (e && e.status === st.status && e.reason && !st.reason) st.reason = e.reason;
      var only = fx.only[stepKey];
      if (only && !only.set[lc(item.name)] && RANK.hidden > RANK[st.status]) st = { status: 'hidden', reason: only.msg };
      return st;
    }
    function changeNotice(stepName, oldName, reason, newName) {
      var why = reason ? ' ' + sentence(reason) : ' It is not available with your other choices.';
      if (newName) return stepName + ' changed from ' + oldName + ' to ' + newName + '.' + why;
      return oldName + ' was removed from ' + stepName + '.' + why;
    }

    var stepViews = [], sizeView = null, fx;
    for (var pass = 0; pass < 8; pass++) {
      var changed = false;
      fx = ruleEffects();

      /* ---- Size ---- */
      var stdViews = sizes.map(function (z) {
        var st = statusFor(z, 'size', fx);
        return { name: z.name, width: z.width, height: z.height, price: showPrices ? z.price : null, stock: z.stock, lead: z.lead, status: st.status, reason: st.reason };
      });
      var customSt = statusFor({ name: CUSTOM, stock: 'In stock' }, 'size', fx);
      var allowStd = allowStdBase && stdViews.some(function (v) { return v.status !== 'hidden'; });
      var allowCustom = allowCustomBase && customSt.status === 'ok';
      var firstStd = stdViews.filter(function (v) { return v.status === 'ok'; })[0];

      if (!size.type) {
        // First load: pick the first available standard size, else custom.
        if (allowStd && firstStd) { size.type = 'standard'; size.name = firstStd.name; }
        else if (allowCustom) size.type = 'custom';
        else size.type = 'standard';
        changed = true;
      } else if (size.type === 'custom' && !allowCustom) {
        if (allowCustomBase) notices.push('Custom sizes are not available with your current choices.' + (customSt.reason ? ' ' + sentence(customSt.reason) : '') + (firstStd ? ' Switched to ' + firstStd.name + '.' : ''));
        size.type = 'standard'; size.name = firstStd ? firstStd.name : null;
        changed = true;
      } else if (size.type === 'standard') {
        var cur = stdViews.filter(function (v) { return lc(v.name) === lc(size.name); })[0];
        if (!cur || cur.status !== 'ok') {
          var prevName = size.name;
          if (firstStd) { size.name = firstStd.name; }
          else if (allowCustom) { size.type = 'custom'; size.name = null; }
          else size.name = null;
          if (prevName && cur) notices.push(changeNotice('Size', prevName, cur.reason, size.type === 'custom' ? 'a custom size' : size.name));
          if (prevName !== size.name || size.type === 'custom') changed = true;
        } else size.name = cur.name;
      }

      /* ---- Steps ---- */
      stepViews = steps.map(function (s) {
        var k = lc(s.name);
        var opts = optsByStep[k].map(function (o) {
          var st = statusFor(o, k, fx);
          return { name: o.name, status: st.status, reason: st.reason, price: showPrices ? o.price : null, priceType: o.priceType,
            color: o.color, swatch: o.swatch || o.color, stock: o.stock, lead: o.lead, description: o.description, isDefault: o.isDefault };
        });
        var gate = fx.gate[k];
        var visible = !fx.hideStep[k] && (!gate || gate.any) && opts.some(function (o) { return o.status !== 'hidden'; });
        return { name: s.name, display: s.display, required: s.required, help: s.help, colorFrom: s.colorFrom, visible: visible, options: opts };
      });

      stepViews.forEach(function (v) {
        var cur = sel[v.name];
        if (!v.visible) {
          if (cur !== undefined) { delete sel[v.name]; changed = true; }
          return;
        }
        var ok = v.options.filter(function (o) { return o.status === 'ok'; });
        var def = ok.filter(function (o) { return o.isDefault; })[0];
        var fallback = def || (v.required ? ok[0] : null);
        var next;
        if (typeof cur === 'string') {
          var hit = v.options.filter(function (o) { return lc(o.name) === lc(cur); })[0];
          if (hit && hit.status === 'ok') next = hit.name;
          else {
            next = fallback ? fallback.name : (v.required ? undefined : null);
            notices.push(changeNotice(v.name, hit ? hit.name : cur, hit ? hit.reason : '', next));
          }
        } else if (cur === undefined || (cur === null && v.required)) {
          next = fallback ? fallback.name : (v.required ? undefined : null);
        } else next = cur;
        if (next !== cur) { changed = true; if (next === undefined) delete sel[v.name]; else sel[v.name] = next; }
      });

      if (!changed) break;
    }

    /* ---- Size details and validation ---- */
    var units = S.units || 'in';
    var stdList = sizes.map(function (z) {
      var st = statusFor(z, 'size', fx);
      return { name: z.name, width: z.width, height: z.height, price: showPrices ? z.price : null, stock: z.stock, lead: z.lead, status: st.status, reason: st.reason };
    });
    var cSt = statusFor({ name: CUSTOM, stock: 'In stock' }, 'size', fx);
    sizeView = {
      units: units,
      allowStandard: allowStdBase && stdList.some(function (v) { return v.status !== 'hidden'; }),
      allowCustom: allowCustomBase && cSt.status === 'ok',
      standard: stdList,
      limits: product.custom ? { minW: product.minW, maxW: product.maxW, minH: product.minH, maxH: product.maxH, step: product.stepSize } : null,
      current: { type: size.type, name: size.name, width: size.width, height: size.height },
      errors: {},
      valid: false, width: null, height: null, label: ''
    };
    if (size.type === 'standard') {
      var zz = stdList.filter(function (v) { return lc(v.name) === lc(size.name) && v.status === 'ok'; })[0];
      if (zz) { sizeView.valid = true; sizeView.width = zz.width; sizeView.height = zz.height; sizeView.label = zz.name + ' ' + units; sizeView.selected = zz; }
    } else if (size.type === 'custom' && sizeView.limits) {
      var L = sizeView.limits;
      var checkDim = function (raw, min, max, label) {
        if (raw === '' || raw === null || raw === undefined) return { empty: true };
        var n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/,/g, '.'));
        if (!isFinite(n) || !/^\s*\d*[.,]?\d+\s*$/.test(String(raw))) return { error: 'Enter the ' + label + ' as a number, like ' + min + '.' };
        if (n < min || n > max) return { error: capitalize(label) + ' must be between ' + min + ' and ' + max + ' ' + units + '.' };
        if (L.step > 0) {
          var q = n / L.step;
          if (Math.abs(q - Math.round(q)) > 1e-6) {
            var lo = round2(Math.floor(q) * L.step), hi = round2(Math.ceil(q) * L.step);
            return { error: capitalize(label) + ' must be in ' + L.step + ' ' + units + ' steps. Try ' + lo + ' or ' + hi + '.' };
          }
        }
        return { value: n };
      };
      var w = checkDim(size.width, L.minW, L.maxW, 'width');
      var h = checkDim(size.height, L.minH, L.maxH, 'height');
      if (w.error) sizeView.errors.width = w.error;
      if (h.error) sizeView.errors.height = h.error;
      if (w.value && h.value) {
        sizeView.valid = true; sizeView.width = w.value; sizeView.height = h.value;
        sizeView.label = w.value + ' x ' + h.value + ' ' + units + ' (custom)';
      }
    }

    /* ---- Price ---- */
    // Exact area is used for math; the rounded one is only for labels.
    var areaExact = sizeView.valid ? sizeView.width * sizeView.height / (units === 'cm' ? 929.0304 : 144) : null;
    var area = areaExact === null ? null : round2(areaExact);
    var lines = [], incomplete = false;
    if (showPrices) {
      lines.push({ label: product.name, amount: product.basePrice || 0 });
      if (size.type === 'standard' && sizeView.selected && sizeView.selected.price) lines.push({ label: 'Size ' + sizeView.selected.name, amount: sizeView.selected.price });
      if (size.type === 'custom') {
        if (area !== null) { if (product.customRate) lines.push({ label: 'Custom size (' + area + ' sq ft)', amount: round2(areaExact * product.customRate) }); }
        else if (product.customRate) incomplete = true;
      }
    }

    /* ---- Selected options: price, layers, summary ---- */
    var layers = [], mirror = false, summary = [], leadTimes = [];
    summary.push({ label: 'Product', value: product.name });
    summary.push({ label: 'Size', value: sizeView.valid ? sizeView.label : 'Not set', lead: (S.showLeadTimes && sizeView.selected && sizeView.selected.lead) || '',
      stock: (S.useInventory && sizeView.selected && sizeView.selected.stock !== 'In stock') ? sizeView.selected.stock : '' });
    if (S.showLeadTimes && sizeView.selected && sizeView.selected.lead) leadTimes.push({ item: 'Size ' + sizeView.selected.name, lead: sizeView.selected.lead });
    if (product.image) layers.push({ src: product.image, z: 0, tint: null, from: 'Products tab, row ' + (product._row || '?') + ', Base image' });

    var colorOf = {};
    stepViews.forEach(function (v) {
      if (!v.visible || typeof sel[v.name] !== 'string') return;
      var o = optsByStep[lc(v.name)].filter(function (x) { return x.name === sel[v.name]; })[0];
      if (o && o.color) colorOf[lc(v.name)] = o.color;
    });

    var missing = [];
    stepViews.forEach(function (v, i) {
      if (!v.visible) return;
      var pick = sel[v.name];
      v.selected = typeof pick === 'string' ? pick : null;
      if (typeof pick !== 'string') {
        if (v.required) missing.push(v.name);
        else summary.push({ label: v.name, value: 'None' });
        return;
      }
      var o = optsByStep[lc(v.name)].filter(function (x) { return x.name === pick; })[0];
      summary.push({ label: v.name, value: o.name, lead: (S.showLeadTimes && o.lead) || '', stock: (S.useInventory && o.stock !== 'In stock') ? o.stock : '' });
      if (S.showLeadTimes && o.lead) leadTimes.push({ item: v.name + ': ' + o.name, lead: o.lead });
      if (o.mirror) mirror = true;
      if (showPrices && o.price) {
        if (o.priceType === 'Per sq ft') {
          if (area !== null) lines.push({ label: v.name + ': ' + o.name + ' (' + area + ' sq ft)', amount: round2(o.price * areaExact) });
          else { lines.push({ label: v.name + ': ' + o.name, amount: null, note: 'priced per sq ft, needs a size' }); incomplete = true; }
        } else lines.push({ label: v.name + ': ' + o.name, amount: o.price });
      }
      if (o.image) {
        layers.push({
          src: o.image,
          z: o.layer !== null && o.layer !== undefined && o.layer !== '' ? Number(o.layer) : (i + 1) * 10,
          tint: v.colorFrom ? (colorOf[lc(v.colorFrom)] || null) : null,
          from: 'Options tab, row ' + (o._row || '?') + ' (' + v.name + ': ' + o.name + ')'
        });
      }
    });
    layers.sort(function (a, b) { return a.z - b.z; });

    var total = null;
    if (showPrices) {
      total = round2(lines.reduce(function (t, l) { return t + (l.amount || 0); }, 0));
    }
    var complete = sizeView.valid && missing.length === 0;

    return {
      product: { name: product.name, description: product.description },
      products: productList.map(function (p) {
        return { name: p.name, description: p.description, basePrice: showPrices ? p.basePrice : null, selected: p === product };
      }),
      size: sizeView,
      steps: stepViews,
      state: {
        product: product.name,
        size: { type: size.type, name: size.name, width: size.width, height: size.height },
        selections: sel
      },
      price: showPrices ? { lines: lines, total: total, incomplete: incomplete, area: area } : null,
      showPrices: showPrices,
      layers: layers,
      mirror: mirror,
      summary: summary,
      leadTimes: leadTimes,
      missing: missing,
      complete: complete,
      notices: notices
    };
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /* Plain-text summary for emails and the Quotes tab. */
  function summaryText(result) {
    return result.summary.map(function (r) {
      return r.label + ': ' + r.value + (r.lead ? ' (' + r.lead + ')' : '') + (r.stock ? ' [' + r.stock + ']' : '');
    }).join('\n');
  }

  return {
    ALL: ALL, SIZE: SIZE, CUSTOM: CUSTOM, OUTPUT: OUTPUT, THEN: THEN, STOCK: STOCK, SIZE_MODES: SIZE_MODES,
    SETTINGS: SETTINGS, TABS: TABS, TAB_ORDER: TAB_ORDER,
    buildConfig: buildConfig,
    publicConfig: publicConfig,
    evaluate: evaluate,
    summaryText: summaryText,
    suggest: suggest,
    _parseValue: parseValue
  };
})();


/* ==========================================================================
   ConfigSample: placeholder door data.
   Used by:
     - Apps Script "Set up / repair sheet" to fill brand-new tabs
     - The website's demo mode (source: 'demo') so you can preview with no backend
   Keys are the column labels Frank sees. Replace with real data in the sheet.
   ========================================================================== */
var ConfigSample = {
  Settings: {
    'What customers see at the end': 'Price and quote request',
    'Currency symbol': '$',
    'Measurement units': 'in',
    'Note under the price': 'Estimate only. Tax, delivery, and installation are not included.',
    'Send quote requests to': '',
    'Quote email subject': 'New door quote request',
    'Email the customer a copy': 'Yes',
    'Contact info shown if something goes wrong': 'Call us at (555) 010-0100.',
    'Use option rules (Rules tab)': 'Yes',
    'Sizes customers can pick': 'Standard and custom sizes',
    'Use stock status': 'Yes',
    'When something is out of stock': 'Show it as unavailable',
    'Show lead times': 'Yes',
    'Let customers choose a product type': 'Yes',
    'Default product': 'Interior Door',
    'Company name': 'Your Company',
    'Configurator heading': 'Build your door',
    'Accent color': '#2F5D50',
    'Logo image (optional)': '',
    'Quote button text': 'Request a quote'
  },

  Products: [
    { 'Product': 'Interior Door', 'Active': 'Yes', 'Description': 'Solid-core, pre-hung interior door.', 'Base price': 289, 'Base image': 'layers/frame-interior.svg',
      'Min width': 18, 'Max width': 40, 'Min height': 72, 'Max height': 96, 'Custom size step': 0.5, 'Custom size price per sq ft': 9, 'Order': 1 },
    { 'Product': 'Exterior Door', 'Active': 'Yes', 'Description': 'Insulated fiberglass entry door.', 'Base price': 749, 'Base image': 'layers/frame-exterior.svg',
      'Min width': 30, 'Max width': 42, 'Min height': 78, 'Max height': 96, 'Custom size step': 0.5, 'Custom size price per sq ft': 22, 'Order': 2 }
  ],

  Steps: [
    { 'Product': 'All products', 'Step': 'Style', 'Active': 'Yes', 'Order': 1, 'Show options as': 'Buttons', 'Required': 'Yes', 'Color comes from': 'Finish', 'Help text': 'Panel layout of the door.' },
    { 'Product': 'All products', 'Step': 'Glass', 'Active': 'Yes', 'Order': 2, 'Show options as': 'Buttons', 'Required': 'Yes', 'Color comes from': '', 'Help text': 'Glass for the window opening.' },
    { 'Product': 'All products', 'Step': 'Finish', 'Active': 'Yes', 'Order': 3, 'Show options as': 'Swatches', 'Required': 'Yes', 'Color comes from': '', 'Help text': 'Factory-applied paint or stain.' },
    { 'Product': 'All products', 'Step': 'Handing', 'Active': 'Yes', 'Order': 4, 'Show options as': 'Buttons', 'Required': 'Yes', 'Color comes from': '', 'Help text': 'Hinge side, viewed from the side the door opens toward.' },
    { 'Product': 'All products', 'Step': 'Hardware', 'Active': 'Yes', 'Order': 5, 'Show options as': 'Buttons', 'Required': 'Yes', 'Color comes from': 'Hardware finish', 'Help text': 'Pick "No hardware" if you have your own.' },
    { 'Product': 'All products', 'Step': 'Hardware finish', 'Active': 'Yes', 'Order': 6, 'Show options as': 'Swatches', 'Required': 'Yes', 'Color comes from': '', 'Help text': '' },
    { 'Product': 'Exterior Door', 'Step': 'Weatherstripping', 'Active': 'Yes', 'Order': 7, 'Show options as': 'Dropdown', 'Required': 'Yes', 'Color comes from': '', 'Help text': 'Seal around the frame.' },
    { 'Product': 'Exterior Door', 'Step': 'Peephole', 'Active': 'Yes', 'Order': 8, 'Show options as': 'Buttons', 'Required': 'No', 'Color comes from': '', 'Help text': 'Optional wide-angle viewer.' }
  ],

  Options: [
    // Style (images get their color from Finish)
    { 'Product': 'All products', 'Step': 'Style', 'Option': 'Flat Panel', 'Default': 'Yes', 'Price': 0, 'Image layer': 'layers/slab-flat.svg', 'Layer order': 20 },
    { 'Product': 'All products', 'Step': 'Style', 'Option': 'Shaker', 'Price': 40, 'Image layer': 'layers/slab-shaker.svg', 'Layer order': 20 },
    { 'Product': 'All products', 'Step': 'Style', 'Option': 'Two Panel', 'Price': 60, 'Image layer': 'layers/slab-two-panel.svg', 'Layer order': 20 },
    { 'Product': 'All products', 'Step': 'Style', 'Option': 'Five Panel', 'Price': 85, 'Image layer': 'layers/slab-five-panel.svg', 'Layer order': 20 },
    { 'Product': 'All products', 'Step': 'Style', 'Option': 'Half Glass', 'Price': 140, 'Image layer': 'layers/slab-half-glass.svg', 'Layer order': 20, 'Description': 'Glass upper, panel lower.' },
    // Glass (only shown for Half Glass, see Rules)
    { 'Product': 'All products', 'Step': 'Glass', 'Option': 'Clear', 'Default': 'Yes', 'Price': 0, 'Image layer': 'layers/glass-clear.svg', 'Layer order': 15 },
    { 'Product': 'All products', 'Step': 'Glass', 'Option': 'Frosted', 'Price': 45, 'Image layer': 'layers/glass-frosted.svg', 'Layer order': 15, 'Description': 'Privacy glass.' },
    { 'Product': 'All products', 'Step': 'Glass', 'Option': 'Rain', 'Price': 65, 'Image layer': 'layers/glass-rain.svg', 'Layer order': 15, 'Stock': 'Backorder', 'Lead time': '4-6 weeks' },
    // Finish (swatches; tints the Style images)
    { 'Product': 'All products', 'Step': 'Finish', 'Option': 'Primed White', 'Default': 'Yes', 'Price': 0, 'Color': '#F4F2EC', 'Description': 'Ready to paint.' },
    { 'Product': 'All products', 'Step': 'Finish', 'Option': 'Natural Oak', 'Price': 120, 'Color': '#C9A46C' },
    { 'Product': 'All products', 'Step': 'Finish', 'Option': 'Walnut', 'Price': 150, 'Color': '#6E4B33' },
    { 'Product': 'All products', 'Step': 'Finish', 'Option': 'Charcoal', 'Price': 90, 'Color': '#3B3F42' },
    { 'Product': 'All products', 'Step': 'Finish', 'Option': 'Sage', 'Price': 90, 'Color': '#9DB08A', 'Stock': 'Low stock' },
    { 'Product': 'Exterior Door', 'Step': 'Finish', 'Option': 'Navy', 'Price': 90, 'Color': '#2C3E5C' },
    // Handing
    { 'Product': 'All products', 'Step': 'Handing', 'Option': 'Right hand', 'Default': 'Yes', 'Price': 0 },
    { 'Product': 'All products', 'Step': 'Handing', 'Option': 'Left hand', 'Price': 0, 'Mirror preview': 'Yes' },
    // Hardware (images get their color from Hardware finish)
    { 'Product': 'All products', 'Step': 'Hardware', 'Option': 'Lever', 'Default': 'Yes', 'Price': 48, 'Image layer': 'layers/hw-lever.svg', 'Layer order': 30 },
    { 'Product': 'All products', 'Step': 'Hardware', 'Option': 'Knob', 'Price': 38, 'Image layer': 'layers/hw-knob.svg', 'Layer order': 30, 'Stock': 'Out of stock' },
    { 'Product': 'All products', 'Step': 'Hardware', 'Option': 'Pull bar', 'Price': 95, 'Image layer': 'layers/hw-pull.svg', 'Layer order': 30 },
    { 'Product': 'All products', 'Step': 'Hardware', 'Option': 'No hardware', 'Price': 0 },
    // Hardware finish
    { 'Product': 'All products', 'Step': 'Hardware finish', 'Option': 'Satin Nickel', 'Default': 'Yes', 'Price': 0, 'Color': '#B8BBBE' },
    { 'Product': 'All products', 'Step': 'Hardware finish', 'Option': 'Matte Black', 'Price': 10, 'Color': '#2B2B2B' },
    { 'Product': 'All products', 'Step': 'Hardware finish', 'Option': 'Brass', 'Price': 15, 'Color': '#C7A04A' },
    // Exterior only
    { 'Product': 'Exterior Door', 'Step': 'Weatherstripping', 'Option': 'Standard foam', 'Default': 'Yes', 'Price': 0 },
    { 'Product': 'Exterior Door', 'Step': 'Weatherstripping', 'Option': 'Compression bulb', 'Price': 40 },
    { 'Product': 'Exterior Door', 'Step': 'Weatherstripping', 'Option': 'Magnetic', 'Price': 75, 'Lead time': '2 weeks' },
    { 'Product': 'Exterior Door', 'Step': 'Peephole', 'Option': 'Add peephole', 'Price': 35 }
  ],

  Sizes: [
    { 'Product': 'Interior Door', 'Size name': '24 x 80', 'Width': 24, 'Height': 80, 'Price': 0 },
    { 'Product': 'Interior Door', 'Size name': '28 x 80', 'Width': 28, 'Height': 80, 'Price': 0 },
    { 'Product': 'Interior Door', 'Size name': '30 x 80', 'Width': 30, 'Height': 80, 'Price': 0 },
    { 'Product': 'Interior Door', 'Size name': '32 x 80', 'Width': 32, 'Height': 80, 'Price': 10 },
    { 'Product': 'Interior Door', 'Size name': '36 x 80', 'Width': 36, 'Height': 80, 'Price': 25 },
    { 'Product': 'Interior Door', 'Size name': '30 x 96', 'Width': 30, 'Height': 96, 'Price': 60 },
    { 'Product': 'Interior Door', 'Size name': '36 x 96', 'Width': 36, 'Height': 96, 'Price': 85, 'Stock': 'Low stock' },
    { 'Product': 'Exterior Door', 'Size name': '32 x 80', 'Width': 32, 'Height': 80, 'Price': 0 },
    { 'Product': 'Exterior Door', 'Size name': '36 x 80', 'Width': 36, 'Height': 80, 'Price': 0 },
    { 'Product': 'Exterior Door', 'Size name': '36 x 96', 'Width': 36, 'Height': 96, 'Price': 180, 'Stock': 'Backorder', 'Lead time': '3-5 weeks' }
  ],

  Rules: [
    { 'Active': 'Yes', 'Product': 'All products', 'When step': 'Style', 'Is': 'Half Glass', 'Then': 'Show step only if picked', 'Target step': 'Glass', 'Target option': '', 'Message to customer': '' },
    { 'Active': 'Yes', 'Product': 'All products', 'When step': 'Hardware', 'Is': 'No hardware', 'Then': 'Hide step', 'Target step': 'Hardware finish', 'Target option': '', 'Message to customer': '' },
    { 'Active': 'Yes', 'Product': 'All products', 'When step': 'Style', 'Is': 'Flat Panel', 'Then': 'Show option as unavailable', 'Target step': 'Finish', 'Target option': 'Natural Oak', 'Message to customer': 'Wood grain finishes need a panel style.' },
    { 'Active': 'Yes', 'Product': 'All products', 'When step': 'Style', 'Is': 'Flat Panel', 'Then': 'Show option as unavailable', 'Target step': 'Finish', 'Target option': 'Walnut', 'Message to customer': 'Wood grain finishes need a panel style.' },
    { 'Active': 'Yes', 'Product': 'All products', 'When step': 'Size', 'Is': 'Custom size', 'Then': 'Only allow option', 'Target step': 'Finish', 'Target option': 'Primed White', 'Message to customer': 'Custom sizes ship primed, ready to paint.' },
    { 'Active': 'Yes', 'Product': 'All products', 'When step': 'Style', 'Is': 'Half Glass', 'Then': 'Hide option', 'Target step': 'Size', 'Target option': '24 x 80', 'Message to customer': 'Half glass needs a door at least 28 in wide.' }
  ]
};

/* Turn the sample into the same grid format a spreadsheet returns:
   { TabName: [[header...], [row...]], ... }  */
ConfigSample.toTables = function () {
  var E = ConfigEngine, t = {};
  t.Settings = [['Setting', 'Value', 'What it does']].concat(E.SETTINGS.map(function (s) {
    var v = ConfigSample.Settings[s.label];
    return [s.label, v === undefined ? '' : v, s.help];
  }));
  Object.keys(E.TABS).forEach(function (tab) {
    var cols = E.TABS[tab].columns.map(function (c) { return c.label; });
    t[tab] = [cols].concat((ConfigSample[tab] || []).map(function (row) {
      return cols.map(function (label) {
        if (row[label] !== undefined) return row[label];
        return label === 'Active' ? 'Yes' : '';
      });
    }));
  });
  t._tabNames = Object.keys(t);
  return t;
};


/* ==========================================================================
   Configurator UI (browser only)
   --------------------------------------------------------------------------
   Embed:
     <link rel="stylesheet" href="/configurator/configurator.css">
     <div id="door-configurator"></div>
     <script src="/configurator/configurator.js"></script>
     <script>
       Configurator.mount('#door-configurator', {
         source: 'script',
         url: 'https://script.google.com/macros/s/XXXX/exec'
       });
     </script>

   Options for mount():
     source     'script' (private sheet, recommended), 'published', or 'demo'
     url        Apps Script web app URL (ends in /exec) for source 'script'
     published  { url, gids } for source 'published' (see README)
     debug      true shows problems with tab/row/fix above the configurator.
                Also turned on by adding ?cfg-debug=1 to the page URL.
     assetBase  folder that relative image paths (layers/x.svg) resolve
                against. Defaults to the folder this script was loaded from.
     showHeader false hides the logo/heading block (use your page's own).
     onQuote    function(payload) called after a quote is sent (analytics).
   ========================================================================== */
(function (global) {
  'use strict';

  var Engine = global.ConfigEngine;
  var Sample = global.ConfigSample;
  var VERSION = '1.0.0';
  var SCRIPT_BASE = (function () {
    var s = document.currentScript && document.currentScript.src;
    return s ? s.replace(/[^/]*(\?.*)?$/, '') : '';
  })();
  var uid = 0;

  /* ----------------------------------------------------------------------
     Errors: every failure carries a customer message (short, friendly)
     and an admin message (what broke, where, how to fix).
     ---------------------------------------------------------------------- */
  function ConfigError(what, fix, extra) {
    this.what = what; this.fix = fix || ''; this.extra = extra || null;
  }
  function logAdmin(what, fix) {
    if (global.console) console.error('[Configurator] ' + what + (fix ? '\n  How to fix: ' + fix : ''));
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ----------------------------------------------------------------------
     Data sources
     ---------------------------------------------------------------------- */
  function fetchText(url, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 20000) : null;
    return fetch(url, { redirect: 'follow', signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (r) {
        clearTimeout(timer);
        return r.text().then(function (t) { return { status: r.status, text: t, url: r.url }; });
      }, function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') throw new ConfigError('The request to ' + url + ' took longer than ' + Math.round((ms || 20000) / 1000) + ' seconds.', 'Check your connection and that the URL is right. Google Apps Script can be slow on the first load after a while; try again.');
        throw new ConfigError('Could not reach ' + url + ' (' + (err && err.message || 'network error') + ').',
          'Check that the URL is correct and the page is online. If the URL is right, an ad blocker or firewall may be blocking script.google.com.');
      });
  }

  function checkScriptUrl(url) {
    if (!url) throw new ConfigError('No Apps Script URL was given.', "Add url: 'https://script.google.com/macros/s/.../exec' to the Configurator.mount() options.");
    if (/docs\.google\.com\/spreadsheets/.test(url)) throw new ConfigError('The URL is the spreadsheet link, not the web app link.', 'In the sheet open Extensions > Apps Script > Deploy > Manage deployments and copy the Web app URL ending in /exec.');
    if (/script\.google\.com\/home|\/edit(\?|$)/.test(url)) throw new ConfigError('The URL points to the script editor, not the web app.', 'Use Deploy > Manage deployments and copy the Web app URL ending in /exec.');
    if (/\/dev(\?|$)/.test(url)) throw new ConfigError('The URL ends in /dev. That test link only works for you while signed in.', 'Use the deployment URL ending in /exec.');
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) throw new ConfigError('The URL "' + url + '" is not a Google Apps Script web app URL.', 'It should start with https://script.google.com/macros/s/ and end in /exec.');
  }

  function parseScriptResponse(res, url) {
    var t = res.text || '';
    if (/^\s*</.test(t)) {
      if (/accounts\.google\.com|ServiceLogin|Sign in/i.test(t) || /accounts\.google\.com/.test(res.url || ''))
        throw new ConfigError('Google asked for a sign-in instead of returning data. The web app is not open to the public.', 'In Apps Script: Deploy > Manage deployments > edit > set "Who has access" to "Anyone" (not "Anyone with a Google account") > Deploy.');
      if (/Script function not found: doGet/i.test(t))
        throw new ConfigError('The web app has no doGet function.', 'Paste the full Code.gs, save, then Deploy > Manage deployments > edit > Version: New version > Deploy.');
      if (/not found|404|Sorry, unable to open the file/i.test(t))
        throw new ConfigError('Google says this web app does not exist (it may have been deleted or the URL is mistyped).', 'Copy the URL again from Deploy > Manage deployments.');
      throw new ConfigError('The web app returned a web page instead of data.', 'Open ' + url + '?action=ping in a browser. It should show {"ok":true...}. If it shows an error, follow what it says, then redeploy as a New version.');
    }
    var data;
    try { data = JSON.parse(t); } catch (e) {
      throw new ConfigError('The web app returned something that is not valid data: ' + t.slice(0, 120), 'Make sure Code.gs is the latest version and redeploy as a New version.');
    }
    return data;
  }

  var sources = {
    script: function (opts, debug) {
      checkScriptUrl(opts.url);
      var u = opts.url + (opts.url.indexOf('?') < 0 ? '?' : '&') + 'action=config' + (debug ? '&debug=1' : '');
      return fetchText(u).then(function (res) {
        var data = parseScriptResponse(res, opts.url);
        if (!data.ok) {
          var first = (data.problems || [])[0] || {};
          throw new ConfigError('The sheet has a blocking problem: ' + (first.message || 'unknown') + (first.tab ? ' (' + first.tab + ' tab)' : ''),
            first.fix || 'Open the sheet and run Configurator > Check for problems.', data.problems || null);
        }
        if (!data.config || !data.config.products) throw new ConfigError('The web app answered but sent no configuration.', 'Redeploy Code.gs as a New version.');
        return { config: data.config, problems: data.problems || null, counts: data.counts || null };
      });
    },

    published: function (opts) {
      var p = opts.published || {};
      if (!p.url) throw new ConfigError('Published mode needs published.url.', 'In the sheet use File > Share > Publish to web, copy the link, and paste it as published.url. Then run Configurator > Show published-mode settings for the tab IDs.');
      var base = p.url.replace(/\/pubhtml.*$/, '/pub').replace(/\/pub\?.*$/, '/pub');
      if (!/\/pub$/.test(base)) throw new ConfigError('published.url does not look like a "Publish to web" link.', 'It should look like https://docs.google.com/spreadsheets/d/e/2PACX-.../pubhtml');
      var gids = p.gids || {};
      var tabs = Engine.TAB_ORDER;
      return Promise.all(tabs.map(function (tab) {
        if (gids[tab] === undefined || gids[tab] === null) return Promise.resolve([tab, null]);
        return fetchText(base + '?gid=' + gids[tab] + '&single=true&output=csv').then(function (res) {
          if (res.status >= 400 || /^\s*</.test(res.text)) throw new ConfigError('The ' + tab + ' tab could not be read as CSV (gid ' + gids[tab] + ').', 'In File > Share > Publish to web, publish the Entire document (or this tab) and check the gid with Configurator > Show published-mode settings.');
          return [tab, parseCSV(res.text)];
        });
      })).then(function (pairs) {
        var tables = { _tabNames: [] };
        pairs.forEach(function (pr) { if (pr[1]) { tables[pr[0]] = pr[1]; tables._tabNames.push(pr[0]); } });
        return fromTables(tables);
      });
    },

    demo: function () {
      if (!Sample) throw new ConfigError('Demo data is not included in this build.', 'Use the full configurator.js bundle.');
      return Promise.resolve(fromTables(Sample.toTables()));
    }
  };

  function fromTables(tables) {
    var built = Engine.buildConfig(tables);
    if (built.fatal) {
      var f = built.problems.filter(function (p) { return p.level === 'fatal'; })[0];
      throw new ConfigError('The sheet has a blocking problem: ' + f.message, f.fix, built.problems);
    }
    return { config: Engine.publicConfig(built.config), problems: built.problems, counts: null };
  }

  // Small RFC 4180 CSV parser (quotes, commas and newlines inside cells).
  function parseCSV(text) {
    var rows = [], row = [], cell = '', q = false, i, ch;
    for (i = 0; i < text.length; i++) {
      ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /* ----------------------------------------------------------------------
     Formatting
     ---------------------------------------------------------------------- */
  function money(n, sym) {
    if (n === null || n === undefined) return '';
    var neg = n < 0; n = Math.abs(n);
    var txt = n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
    return (neg ? '-' : '') + (sym || '$') + txt;
  }
  function delta(n, sym, perSqFt) {
    if (n === null || n === undefined || n === 0) return '';
    return (n > 0 ? '+' : '-') + money(Math.abs(n), sym) + (perSqFt ? '/sq ft' : '');
  }
  function contrastOn(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#fff';
    var v = parseInt(m[1], 16), r = v >> 16 & 255, g = v >> 8 & 255, b = v & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#1b1f20' : '#ffffff';
  }

  /* ----------------------------------------------------------------------
     The configurator instance
     ---------------------------------------------------------------------- */
  function Instance(root, opts) {
    this.root = root;
    this.opts = opts;
    this.id = 'cfg' + (++uid);
    this.debug = !!opts.debug || /[?&]cfg-debug=1\b/.test(global.location.search);
    this.state = {};
    this.problems = null;
    this.imageProblems = {};
    root.classList.add('cfg');
    root.setAttribute('data-cfg-version', VERSION);
    this.renderLoading();
    this.load();
  }

  Instance.prototype.load = function () {
    var self = this, src = sources[this.opts.source];
    var p;
    try {
      if (!src) throw new ConfigError('Unknown source "' + this.opts.source + '".', "Use source: 'script', 'published' or 'demo'.");
      p = src(this.opts, this.debug);
    } catch (e) { p = Promise.reject(e); }
    p.then(function (data) {
      self.cfg = data.config;
      self.problems = data.problems;
      self.counts = data.counts;
      self.renderShell();
      self.update();
    }).catch(function (err) { self.fail(err); });
  };

  Instance.prototype.fail = function (err) {
    var e = err instanceof ConfigError ? err : new ConfigError('Unexpected error: ' + (err && err.message || err), 'Open the browser console for details and run Configurator > Check for problems in the sheet.');
    if (!(err instanceof ConfigError) && global.console) console.error(err);
    logAdmin(e.what, e.fix);
    var contact = this.cfg && this.cfg.settings && this.cfg.settings.publicContact;
    var html = '<div class="cfg-unavailable" role="alert">' +
      '<p class="cfg-unavailable__title">The configurator is unavailable right now.</p>' +
      '<p>' + esc(contact || 'Please try again in a few minutes.') + '</p>' +
      '<button type="button" class="cfg-btn cfg-btn--secondary" data-action="retry">Try again</button></div>';
    if (this.debug) html = this.adminPanel([{ level: 'fatal', message: e.what, fix: e.fix }].concat((e.extra || []).filter(function (p) { return p.message !== e.what.replace(/^The sheet has a blocking problem: /, ''); }))) + html;
    this.root.innerHTML = html;
    var self = this;
    this.root.querySelector('[data-action="retry"]').addEventListener('click', function () { self.renderLoading(); self.load(); });
  };

  Instance.prototype.renderLoading = function () {
    this.root.innerHTML = '<div class="cfg-loading" aria-busy="true"><span class="cfg-spinner" aria-hidden="true"></span><span>Loading options</span></div>';
  };

  /* Debug panel: problems from the sheet, plus broken images found at runtime */
  Instance.prototype.adminPanel = function (problems) {
    var list = (problems || []).slice();
    var self = this;
    Object.keys(this.imageProblems).forEach(function (k) { list.push(self.imageProblems[k]); });
    var order = { fatal: 0, error: 1, warning: 2 };
    list.sort(function (a, b) { return order[a.level] - order[b.level]; });
    var src = this.opts.source === 'script' ? 'Private sheet via Apps Script' : this.opts.source === 'published' ? 'Published sheet (public)' : 'Demo data (no sheet)';
    var label = { fatal: 'Blocking', error: 'Row skipped', warning: 'Warning' };
    var body = list.length ? '<ol class="cfg-admin__list">' + list.map(function (p) {
      var where = [p.tab ? p.tab + ' tab' : '', p.row ? 'row ' + p.row : '', p.column || ''].filter(Boolean).join(', ');
      return '<li class="cfg-admin__item cfg-admin__item--' + p.level + '"><span class="cfg-admin__level">' + label[p.level] + '</span>' +
        (where ? '<span class="cfg-admin__where">' + esc(where) + '</span>' : '') +
        '<span class="cfg-admin__msg">' + esc(p.message) + '</span>' +
        (p.fix ? '<span class="cfg-admin__fix"><b>Fix:</b> ' + esc(p.fix) + '</span>' : '') + '</li>';
    }).join('') + '</ol>' : '<p class="cfg-admin__ok">No problems found.</p>';
    return '<details class="cfg-admin"' + (list.some(function (p) { return p.level !== 'warning'; }) ? ' open' : '') + '>' +
      '<summary>Admin: ' + list.length + ' problem' + (list.length === 1 ? '' : 's') + ' <span class="cfg-admin__src">' + esc(src) + ' · debug mode, customers do not see this</span></summary>' + body + '</details>';
  };

  Instance.prototype.renderShell = function () {
    var S = this.cfg.settings, id = this.id;
    var accent = S.accentColor || '#2F5D50';
    this.root.style.setProperty('--cfg-accent', accent);
    this.root.style.setProperty('--cfg-on-accent', contrastOn(accent));
    var showHeader = this.opts.showHeader !== false && (S.title || S.logoUrl);
    var quote = S.outputMode !== Engine.OUTPUT.PRICE;
    this.root.innerHTML =
      (this.debug ? '<div class="cfg-admin-slot"></div>' : '') +
      (showHeader ? '<header class="cfg-header">' +
        (S.logoUrl ? '<img class="cfg-header__logo" src="' + esc(this.asset(S.logoUrl)) + '" alt="' + esc(S.companyName || '') + '">' : '') +
        (S.title ? '<h2 class="cfg-header__title">' + esc(S.title) + '</h2>' : '') + '</header>' : '') +
      '<div class="cfg-layout">' +
        '<div class="cfg-preview"><div class="cfg-preview__inner">' +
          '<div class="cfg-stage" role="img"></div>' +
          '<p class="cfg-preview__caption"></p>' +
        '</div></div>' +
        '<div class="cfg-panel">' +
          '<div class="cfg-notices" aria-live="polite"></div>' +
          '<form class="cfg-steps" novalidate onsubmit="return false"></form>' +
          '<section class="cfg-summary" id="' + id + '-summary" aria-labelledby="' + id + '-summary-title"></section>' +
          (quote ? this.quoteFormHtml() : '') +
        '</div>' +
      '</div>' +
      '<div class="cfg-bar" aria-hidden="true"></div>';
    this.bind();
  };

  Instance.prototype.quoteFormHtml = function () {
    var id = this.id, S = this.cfg.settings;
    function field(name, label, type, req, extra) {
      return '<div class="cfg-field">' +
        '<label class="cfg-field__label" for="' + id + '-' + name + '">' + label + (req ? '' : ' <span class="cfg-field__opt">(optional)</span>') + '</label>' +
        (type === 'textarea' ? '<textarea class="cfg-input" id="' + id + '-' + name + '" name="' + name + '" rows="3" maxlength="2000"></textarea>'
          : '<input class="cfg-input" id="' + id + '-' + name + '" name="' + name + '" type="' + type + '"' + (req ? ' required' : '') + (extra || '') + '>') +
        '<p class="cfg-field__error" id="' + id + '-' + name + '-err" hidden></p></div>';
    }
    return '<section class="cfg-quote" id="' + id + '-quote" hidden aria-labelledby="' + id + '-quote-title">' +
      '<h3 class="cfg-section-title" id="' + id + '-quote-title">' + esc(S.quoteButton || 'Request a quote') + '</h3>' +
      '<form class="cfg-quote__form" novalidate>' +
        '<div class="cfg-quote__grid">' +
          field('name', 'Name', 'text', true, ' autocomplete="name" maxlength="120"') +
          field('email', 'Email', 'email', true, ' autocomplete="email" maxlength="200"') +
          field('phone', 'Phone', 'tel', false, ' autocomplete="tel" maxlength="40"') +
          field('zip', 'ZIP / Postal code', 'text', false, ' autocomplete="postal-code" maxlength="20"') +
        '</div>' +
        field('notes', 'Anything else we should know?', 'textarea', false) +
        // Honeypot: hidden from people, bots fill it in.
        '<div class="cfg-hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>' +
        '<p class="cfg-quote__status" role="status" aria-live="polite"></p>' +
        '<button type="submit" class="cfg-btn cfg-btn--primary cfg-btn--block">Send request</button>' +
      '</form>' +
      '<div class="cfg-quote__done" hidden></div>' +
    '</section>';
  };

  Instance.prototype.asset = function (src) {
    if (!src) return '';
    if (/^(https?:|data:|blob:|\/)/i.test(src)) return src;
    var base = this.opts.assetBase !== undefined ? this.opts.assetBase : SCRIPT_BASE;
    if (base && !/\/$/.test(base)) base += '/';
    return base + src;
  };

  /* ----------------------------------------------------------------------
     Events (one delegated listener; survives re-renders)
     ---------------------------------------------------------------------- */
  Instance.prototype.bind = function () {
    var self = this, root = this.root, timer;
    root.addEventListener('change', function (e) {
      var t = e.target, k = t.getAttribute('data-kind');
      if (!k) return;
      if (k === 'product') { self.state = { product: t.value }; }
      else if (k === 'option') { self.state.selections[t.getAttribute('data-step')] = t.value === '__none__' ? null : t.value; }
      else if (k === 'size') { self.state.size = { type: 'standard', name: t.value }; }
      else if (k === 'size-mode') {
        var cur = self.state.size || {};
        self.state.size = t.value === 'custom'
          ? { type: 'custom', width: cur.width || (self.last.size.width || ''), height: cur.height || (self.last.size.height || '') }
          : { type: 'standard', name: self.lastStandard || null };
      } else if (k === 'custom-w' || k === 'custom-h') {
        clearTimeout(timer);
        self.touchedCustom = true;
        return self.update({ typing: true });
      } else return;
      self.update();
    });
    root.addEventListener('input', function (e) {
      var k = e.target.getAttribute('data-kind');
      if (k !== 'custom-w' && k !== 'custom-h') return;
      self.state.size = self.state.size || { type: 'custom' };
      self.state.size.type = 'custom';
      self.state.size[k === 'custom-w' ? 'width' : 'height'] = e.target.value;
      clearTimeout(timer);
      timer = setTimeout(function () { self.touchedCustom = true; self.update({ typing: true }); }, 500);
    });
    root.addEventListener('click', function (e) {
      var a = e.target.closest('[data-action]');
      if (!a || !root.contains(a)) return;
      var act = a.getAttribute('data-action');
      if (act === 'open-quote') self.openQuote();
      if (act === 'jump-summary') self.root.querySelector('.cfg-summary').scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (act === 'restart') self.restart();
      if (act === 'dismiss-notices') self.root.querySelector('.cfg-notices').innerHTML = '';
    });
    var form = root.querySelector('.cfg-quote__form');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); self.submitQuote(form); });
  };

  /* ----------------------------------------------------------------------
     Update cycle: evaluate -> render the parts that change
     ---------------------------------------------------------------------- */
  Instance.prototype.update = function (o) {
    o = o || {};
    var focus = this.captureFocus();
    var r;
    try { r = Engine.evaluate(this.cfg, this.state); }
    catch (err) { return this.fail(err); }
    this.last = r;
    this.state = {
      product: r.state.product,
      size: r.state.size,
      selections: r.state.selections
    };
    if (r.state.size.type === 'standard' && r.state.size.name) this.lastStandard = r.state.size.name;
    this.renderSteps(r);
    this.renderPreview(r);
    this.renderSummary(r);
    // While typing a custom size, keep earlier notices unless new ones appear.
    if (!o.typing || r.notices.length) this.renderNotices(r.notices);
    this.renderAdmin();
    this.restoreFocus(focus);
  };

  Instance.prototype.captureFocus = function () {
    var a = document.activeElement;
    if (!a || !this.root.contains(a)) return null;
    var key = a.getAttribute('data-focus');
    if (!key) return null;
    var f = { key: key };
    try { f.start = a.selectionStart; f.end = a.selectionEnd; } catch (e) { /* radios */ }
    return f;
  };
  Instance.prototype.restoreFocus = function (f) {
    if (!f) return;
    var el = this.root.querySelector('[data-focus="' + f.key.replace(/"/g, '\\"') + '"]');
    if (!el) return;
    el.focus({ preventScroll: true });
    try { if (f.start != null) el.setSelectionRange(f.start, f.end); } catch (e) { /* ignore */ }
  };

  Instance.prototype.renderNotices = function (notices) {
    var box = this.root.querySelector('.cfg-notices');
    if (!notices.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="cfg-notice"><ul>' + notices.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') +
      '</ul><button type="button" class="cfg-notice__close" data-action="dismiss-notices" aria-label="Dismiss">&times;</button></div>';
  };

  Instance.prototype.renderAdmin = function () {
    if (!this.debug) return;
    var slot = this.root.querySelector('.cfg-admin-slot');
    if (!slot) return;
    var wasOpen = slot.querySelector('details') && slot.querySelector('details').open;
    var problems = this.problems;
    if (!problems && this.counts) problems = [{ level: 'warning', message: 'Problem details were not loaded.', fix: 'Reload the page with ?cfg-debug=1.' }];
    slot.innerHTML = this.adminPanel(problems || []);
    if (wasOpen) slot.querySelector('details').open = true;
  };

  /* ---- Steps ---- */
  Instance.prototype.renderSteps = function (r) {
    var S = this.cfg.settings, sym = S.currency, self = this, id = this.id;
    var html = '';

    // Product picker
    if (r.products.length > 1) {
      html += '<fieldset class="cfg-step cfg-step--product"><legend class="cfg-step__title">Product</legend>' +
        '<div class="cfg-options cfg-options--cards">' + r.products.map(function (p, i) {
          return '<label class="cfg-option cfg-option--card' + (p.selected ? ' is-selected' : '') + '">' +
            '<input type="radio" name="' + id + '-product" value="' + esc(p.name) + '" data-kind="product" data-focus="product:' + esc(p.name) + '"' + (p.selected ? ' checked' : '') + '>' +
            '<span class="cfg-option__name">' + esc(p.name) + '</span>' +
            (p.description ? '<span class="cfg-option__desc">' + esc(p.description) + '</span>' : '') +
            (p.basePrice !== null ? '<span class="cfg-option__price">From ' + money(p.basePrice, sym) + '</span>' : '') +
          '</label>';
        }).join('') + '</div></fieldset>';
    } else if (r.product.description) {
      html += '<p class="cfg-product-desc">' + esc(r.product.description) + '</p>';
    }

    // Size
    html += this.sizeHtml(r);

    // Configurable steps
    r.steps.forEach(function (st, si) {
      if (!st.visible) return;
      var name = id + '-s' + si;
      var vis = st.options.filter(function (o) { return o.status !== 'hidden'; });
      var head = '<legend class="cfg-step__title">' + esc(st.name) + (st.selected ? '<span class="cfg-step__value">' + esc(st.selected) + '</span>' : '') + '</legend>' +
        (st.help ? '<p class="cfg-step__help">' + esc(st.help) + '</p>' : '');
      var body;
      if (st.display === 'Dropdown') {
        body = '<div class="cfg-select-wrap"><select class="cfg-select" data-kind="option" data-step="' + esc(st.name) + '" data-focus="step:' + esc(st.name) + '" aria-label="' + esc(st.name) + '">' +
          (st.required ? (st.selected ? '' : '<option value="" disabled selected>Choose...</option>') : '<option value="__none__"' + (st.selected ? '' : ' selected') + '>None</option>') +
          vis.map(function (o) {
            var extra = [delta(o.price, sym, o.priceType === 'Per sq ft'), self.stockText(o), o.status === 'unavailable' ? (o.reason || 'Unavailable') : ''].filter(Boolean).join(' · ');
            return '<option value="' + esc(o.name) + '"' + (o.name === st.selected ? ' selected' : '') + (o.status !== 'ok' ? ' disabled' : '') + '>' +
              esc(o.name) + (extra ? ' (' + esc(extra) + ')' : '') + '</option>';
          }).join('') + '</select></div>';
      } else {
        var swatch = st.display === 'Swatches';
        var none = st.required ? '' : self.optionHtml({ name: 'None', status: 'ok' }, name, st, swatch, '__none__', !st.selected);
        body = '<div class="cfg-options cfg-options--' + (swatch ? 'swatches' : 'buttons') + '">' + none +
          vis.map(function (o) { return self.optionHtml(o, name, st, swatch, o.name, o.name === st.selected); }).join('') + '</div>';
        var cur = vis.filter(function (o) { return o.name === st.selected; })[0];
        if (cur && cur.description) body += '<p class="cfg-step__detail">' + esc(cur.description) + '</p>';
        body += self.reasonsHtml(vis);
      }
      html += '<fieldset class="cfg-step" data-step="' + esc(st.name) + '">' + head + body + '</fieldset>';
    });

    this.root.querySelector('.cfg-steps').innerHTML = html;
  };

  // Long "why unavailable" messages are grouped under the step instead of
  // squeezed into each option: "Natural Oak, Walnut: Wood grain finishes..."
  Instance.prototype.reasonsHtml = function (opts) {
    var groups = {}, order = [];
    opts.forEach(function (o) {
      if (o.status !== 'unavailable' || !o.reason || o.reason.length <= 16) return;
      if (!groups[o.reason]) { groups[o.reason] = []; order.push(o.reason); }
      groups[o.reason].push(o.name);
    });
    return order.map(function (r) { return '<p class="cfg-step__unavailable">' + esc(groups[r].join(', ')) + ': ' + esc(r) + '</p>'; }).join('');
  };

  Instance.prototype.stockText = function (o) {
    var S = this.cfg.settings;
    var bits = [];
    if (S.useInventory && o.stock && o.stock !== 'In stock' && o.status === 'ok') bits.push(o.stock);
    if (S.showLeadTimes && o.lead && o.status === 'ok') bits.push(o.lead);
    return bits.join(', ');
  };

  Instance.prototype.optionHtml = function (o, group, st, swatch, value, selected) {
    var S = this.cfg.settings;
    var unavailable = o.status === 'unavailable';
    var price = o.name === 'None' && value === '__none__' ? '' : delta(o.price, S.currency, o.priceType === 'Per sq ft');
    var stock = this.stockText(o);
    var sw = '';
    if (swatch) {
      var v = o.swatch || '';
      var style = /^#/.test(v) ? 'background:' + v : v ? 'background-image:url(\'' + esc(this.asset(v)) + '\')' : '';
      sw = '<span class="cfg-swatch' + (value === '__none__' ? ' cfg-swatch--none' : '') + '" style="' + style + '" aria-hidden="true"></span>';
    }
    return '<label class="cfg-option' + (swatch ? ' cfg-option--swatch' : '') + (selected ? ' is-selected' : '') + (unavailable ? ' is-unavailable' : '') + '"' +
      (o.description ? ' title="' + esc(o.description) + '"' : unavailable && o.reason ? ' title="' + esc(o.reason) + '"' : '') + '>' +
      '<input type="radio" name="' + group + '" value="' + esc(value) + '" data-kind="option" data-step="' + esc(st.name) + '" data-focus="opt:' + esc(st.name) + ':' + esc(value) + '"' +
        (selected ? ' checked' : '') + (unavailable ? ' disabled' : '') + '>' +
      sw +
      '<span class="cfg-option__text">' +
        '<span class="cfg-option__name">' + esc(o.name) + '</span>' +
        (price ? '<span class="cfg-option__price">' + esc(price) + '</span>' : '') +
        (unavailable && (!o.reason || o.reason.length <= 16) ? '<span class="cfg-option__note">' + esc(o.reason || 'Unavailable') + '</span>' : '') +
        (stock ? '<span class="cfg-badge">' + esc(stock) + '</span>' : '') +
      '</span></label>';
  };

  Instance.prototype.sizeHtml = function (r) {
    var z = r.size, S = this.cfg.settings, id = this.id, self = this, sym = S.currency;
    var isCustom = z.current.type === 'custom';
    var html = '<fieldset class="cfg-step cfg-step--size" data-step="Size"><legend class="cfg-step__title">Size' +
      (z.valid ? '<span class="cfg-step__value">' + esc(z.label) + '</span>' : '') + '</legend>';
    if (z.allowStandard && z.allowCustom) {
      html += '<div class="cfg-segment" role="radiogroup" aria-label="Size type">' +
        '<label class="cfg-segment__item' + (!isCustom ? ' is-selected' : '') + '"><input type="radio" name="' + id + '-sizemode" value="standard" data-kind="size-mode" data-focus="sizemode:standard"' + (!isCustom ? ' checked' : '') + '>Standard</label>' +
        '<label class="cfg-segment__item' + (isCustom ? ' is-selected' : '') + '"><input type="radio" name="' + id + '-sizemode" value="custom" data-kind="size-mode" data-focus="sizemode:custom"' + (isCustom ? ' checked' : '') + '>Custom</label>' +
        '</div>';
    }
    if (!isCustom && z.allowStandard) {
      html += '<div class="cfg-options cfg-options--buttons">' + z.standard.filter(function (s) { return s.status !== 'hidden'; }).map(function (s) {
        var unavailable = s.status === 'unavailable';
        var sel = s.name === z.current.name;
        var stock = self.stockText(s);
        return '<label class="cfg-option' + (sel ? ' is-selected' : '') + (unavailable ? ' is-unavailable' : '') + '"' + (unavailable && s.reason ? ' title="' + esc(s.reason) + '"' : '') + '>' +
          '<input type="radio" name="' + id + '-size" value="' + esc(s.name) + '" data-kind="size" data-focus="size:' + esc(s.name) + '"' + (sel ? ' checked' : '') + (unavailable ? ' disabled' : '') + '>' +
          '<span class="cfg-option__text"><span class="cfg-option__name">' + esc(s.name) + '</span>' +
          (s.price ? '<span class="cfg-option__price">' + esc(delta(s.price, sym)) + '</span>' : '') +
          (unavailable && (!s.reason || s.reason.length <= 16) ? '<span class="cfg-option__note">' + esc(s.reason || 'Unavailable') + '</span>' : '') +
          (stock ? '<span class="cfg-badge">' + esc(stock) + '</span>' : '') + '</span></label>';
      }).join('') + '</div>' + self.reasonsHtml(z.standard.filter(function (s) { return s.status !== 'hidden'; }));
    }
    if (isCustom && z.limits) {
      var L = z.limits, u = z.units, show = this.touchedCustom;
      var input = function (key, label, val, min, max, err) {
        var eid = id + '-' + key + '-err';
        return '<div class="cfg-field"><label class="cfg-field__label" for="' + id + '-' + key + '">' + label + ' (' + u + ')</label>' +
          '<input class="cfg-input' + (err && show ? ' is-invalid' : '') + '" id="' + id + '-' + key + '" type="text" inputmode="decimal" autocomplete="off" value="' + esc(val) + '"' +
          ' data-kind="custom-' + key.charAt(0) + '" data-focus="custom-' + key + '" aria-describedby="' + eid + '"' + (err && show ? ' aria-invalid="true"' : '') + '>' +
          '<p class="cfg-field__hint">' + min + ' to ' + max + '</p>' +
          '<p class="cfg-field__error" id="' + eid + '"' + (err && show ? '' : ' hidden') + '>' + esc(err || '') + '</p></div>';
      };
      html += '<div class="cfg-custom">' +
        input('width', 'Width', z.current.width, L.minW, L.maxW, z.errors.width) +
        input('height', 'Height', z.current.height, L.minH, L.maxH, z.errors.height) + '</div>' +
        (L.step ? '<p class="cfg-step__help">Custom sizes in ' + L.step + ' ' + u + ' steps.</p>' : '');
    }
    if (!z.allowStandard && !z.allowCustom) html += '<p class="cfg-step__help">No sizes are available for this product right now.</p>';
    return html + '</fieldset>';
  };

  /* ---- Preview ---- */
  Instance.prototype.renderPreview = function (r) {
    var stage = this.root.querySelector('.cfg-stage'), self = this;
    stage.classList.toggle('is-mirrored', !!r.mirror);
    var html = r.layers.map(function (l) {
      var src = self.asset(l.src);
      var img = '<img src="' + esc(src) + '" alt="" draggable="false" data-from="' + esc(l.from) + '" data-src="' + esc(l.src) + '">';
      if (!l.tint) return '<div class="cfg-layer" style="z-index:' + l.z + '">' + img + '</div>';
      // Tinted layer: the color is masked to the image shape, then the image
      // multiplies on top so its shading shows through the color.
      var url = 'url("' + src.replace(/"/g, '%22') + '")';
      return '<div class="cfg-layer cfg-layer--tinted" style="z-index:' + l.z + ';--cfg-tint:' + esc(l.tint) + ';--cfg-mask:' + esc(url) + '">' +
        '<span class="cfg-layer__tint"></span>' + img + '</div>';
    }).join('');
    if (!r.layers.length) html = '<div class="cfg-stage__empty">No preview images set</div>';
    stage.innerHTML = html;
    stage.setAttribute('aria-label', 'Preview: ' + r.summary.map(function (s) { return s.label + ' ' + s.value; }).join(', '));
    stage.querySelectorAll('img').forEach(function (img) {
      img.addEventListener('error', function () {
        img.parentNode.classList.add('is-broken');
        var key = img.getAttribute('data-src');
        if (self.imageProblems[key]) return;
        self.imageProblems[key] = { level: 'error', tab: '', message: 'Image did not load: ' + img.src + ' (from ' + img.getAttribute('data-from') + ').',
          fix: 'Open the address in a browser to check it exists. Relative paths like layers/x.svg load from ' + (self.asset('') || 'the page folder') + '. Google Drive share links do not work as images.' };
        logAdmin(self.imageProblems[key].message, self.imageProblems[key].fix);
        self.renderAdmin();
      }, { once: true });
    });
    var cap = this.root.querySelector('.cfg-preview__caption');
    cap.textContent = [r.product.name, r.size.valid ? r.size.label : ''].filter(Boolean).join(' · ');
  };

  /* ---- Summary, price, quote button ---- */
  Instance.prototype.renderSummary = function (r) {
    var S = this.cfg.settings, sym = S.currency, id = this.id;
    var quote = S.outputMode !== Engine.OUTPUT.PRICE;
    var html = '<h3 class="cfg-section-title" id="' + id + '-summary-title">Your selections</h3>' +
      '<dl class="cfg-summary__list">' + r.summary.map(function (s) {
        return '<div class="cfg-summary__row"><dt>' + esc(s.label) + '</dt><dd>' + esc(s.value) +
          (s.stock ? ' <span class="cfg-badge">' + esc(s.stock) + '</span>' : '') +
          (s.lead ? ' <span class="cfg-summary__lead">' + esc(s.lead) + '</span>' : '') + '</dd></div>';
      }).join('') + '</dl>';

    if (r.price) {
      html += '<div class="cfg-price" aria-live="polite"><span class="cfg-price__label">Estimated total</span>' +
        '<span class="cfg-price__total">' + money(r.price.total, sym) + (r.price.incomplete ? '+' : '') + '</span></div>' +
        '<details class="cfg-breakdown"><summary>Price breakdown</summary><table class="cfg-breakdown__table"><tbody>' +
        r.price.lines.map(function (l) {
          return '<tr><td>' + esc(l.label) + '</td><td>' + (l.amount === null ? esc(l.note || '') : esc(money(l.amount, sym))) + '</td></tr>';
        }).join('') + '</tbody></table></details>' +
        (S.priceNote ? '<p class="cfg-price__note">' + esc(S.priceNote) + '</p>' : '');
    }
    if (!r.complete) {
      var need = r.missing.slice();
      if (!r.size.valid) need.unshift('a size');
      html += '<p class="cfg-summary__missing">To continue, choose ' + esc(need.join(', ')) + '.</p>';
    }
    if (quote && !this.quoteSent) {
      html += '<button type="button" class="cfg-btn cfg-btn--primary cfg-btn--block" data-action="open-quote"' + (r.complete ? '' : ' disabled') + '>' +
        esc(S.quoteButton || 'Request a quote') + '</button>';
    }
    this.root.querySelector('.cfg-summary').innerHTML = html;

    var bar = this.root.querySelector('.cfg-bar');
    bar.innerHTML = (r.price ? '<span class="cfg-bar__price">' + money(r.price.total, sym) + (r.price.incomplete ? '+' : '') + '</span>' : '<span class="cfg-bar__price">' + esc(r.product.name) + '</span>') +
      '<button type="button" class="cfg-btn cfg-btn--primary" data-action="jump-summary" tabindex="-1">Review</button>';

    var qs = this.root.querySelector('.cfg-quote');
    if (qs && !r.complete && !qs.hidden && !this.quoteSent) {
      qs.querySelector('.cfg-quote__status').textContent = 'Finish your selections above before sending.';
    } else if (qs && !this.quoteSent) qs.querySelector('.cfg-quote__status').textContent = '';
  };

  /* ---- Quote form ---- */
  Instance.prototype.openQuote = function () {
    var qs = this.root.querySelector('.cfg-quote');
    if (!qs) return;
    qs.hidden = false;
    qs.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var first = qs.querySelector('input[name="name"]');
    setTimeout(function () { first.focus({ preventScroll: true }); }, 350);
  };

  Instance.prototype.submitQuote = function (form) {
    var self = this, S = this.cfg.settings, id = this.id;
    var status = form.querySelector('.cfg-quote__status');
    var btn = form.querySelector('button[type="submit"]');
    var val = function (n) { return (form.elements[n] && form.elements[n].value || '').trim(); };
    var contact = { name: val('name'), email: val('email'), phone: val('phone'), zip: val('zip'), notes: val('notes') };

    // Client-side checks (the server checks again)
    var errs = {};
    if (!contact.name) errs.name = 'Please enter your name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) errs.email = 'Please enter a valid email address, like name@example.com.';
    ['name', 'email'].forEach(function (n) { self.setFieldError(n, errs[n]); });
    if (errs.name || errs.email) { form.querySelector('[aria-invalid="true"]').focus(); return; }
    if (!this.last.complete) { status.textContent = 'Finish your selections above before sending.'; return; }

    var payload = { action: 'quote', state: this.state, contact: contact, page: global.location.href, website: val('website') };
    btn.disabled = true; btn.textContent = 'Sending...'; status.textContent = '';

    this.sendQuote(payload).then(function (res) {
      if (!res.ok) {
        if (res.field) { self.setFieldError(res.field, res.message); form.elements[res.field].focus(); }
        else status.textContent = res.message || 'Something went wrong. Please try again.';
        return;
      }
      self.quoteSent = true;
      form.hidden = true;
      var done = self.root.querySelector('.cfg-quote__done');
      done.hidden = false;
      done.innerHTML = '<p class="cfg-quote__thanks">Thanks, ' + esc(contact.name.split(' ')[0]) + '. Your request is in.</p>' +
        '<p>Reference number: <b>' + esc(res.quoteId) + '</b>. We will reply to ' + esc(contact.email) + '.</p>' +
        '<button type="button" class="cfg-btn cfg-btn--secondary" data-action="restart">Start a new configuration</button>';
      done.setAttribute('tabindex', '-1'); done.focus();
      self.renderSummary(self.last);
      if (typeof self.opts.onQuote === 'function') { try { self.opts.onQuote({ quoteId: res.quoteId, state: self.state, summary: self.last.summary }); } catch (e) { /* ignore */ } }
    }).catch(function (err) {
      var e = err instanceof ConfigError ? err : new ConfigError(String(err && err.message || err));
      logAdmin('Quote could not be sent. ' + e.what, e.fix);
      status.innerHTML = 'We could not send your request. Your details are still here, so you can try again.' + (S.publicContact ? ' ' + esc(S.publicContact) : '') +
        (self.debug ? '<br><small class="cfg-admin-inline">Admin: ' + esc(e.what) + ' ' + esc(e.fix) + '</small>' : '');
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Send request';
    });
  };

  Instance.prototype.setFieldError = function (name, msg) {
    var input = this.root.querySelector('#' + this.id + '-' + name);
    var p = this.root.querySelector('#' + this.id + '-' + name + '-err');
    if (!input || !p) return;
    if (msg) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', p.id); input.classList.add('is-invalid'); p.textContent = msg; p.hidden = false; }
    else { input.removeAttribute('aria-invalid'); input.classList.remove('is-invalid'); p.hidden = true; }
  };

  Instance.prototype.sendQuote = function (payload) {
    var o = this.opts;
    if (o.source === 'demo') {
      if (global.console) console.info('[Configurator] Demo mode: quote not sent. Payload:', payload);
      return new Promise(function (res) { setTimeout(function () { res({ ok: true, quoteId: 'Q-DEMO-' + Math.random().toString(36).slice(2, 6).toUpperCase() }); }, 700); });
    }
    if (o.source === 'published') {
      return Promise.reject(new ConfigError('Published mode cannot receive quote requests (there is no private backend).',
        'Switch to source: \'script\', or set "What customers see at the end" to "Price only".'));
    }
    // text/plain keeps this a "simple" request, so the browser skips the CORS preflight Apps Script cannot answer.
    return fetch(o.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' })
      .then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t, url: r.url }; }); },
        function (err) { throw new ConfigError('Network error while sending (' + (err && err.message) + ').', 'Check the connection and that the web app URL is correct.'); })
      .then(function (res) { return parseScriptResponse(res, o.url); });
  };

  Instance.prototype.restart = function () {
    this.quoteSent = false;
    this.state = {};
    this.touchedCustom = false;
    this.renderShell();
    this.update();
    this.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /* ----------------------------------------------------------------------
     Public API
     ---------------------------------------------------------------------- */
  function mount(target, opts) {
    opts = opts || {};
    if (!opts.source) opts.source = opts.url ? 'script' : 'demo';
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) {
      logAdmin('Could not find the element "' + target + '" on this page.', 'Add <div id="door-configurator"></div> to the page before the script, or fix the selector passed to Configurator.mount().');
      return null;
    }
    if (!global.fetch || !global.Promise) {
      el.innerHTML = '<div class="cfg-unavailable">This configurator needs a newer browser.</div>';
      return null;
    }
    if (el._cfg) return el._cfg;
    el._cfg = new Instance(el, opts);
    return el._cfg;
  }

  global.Configurator = { mount: mount, version: VERSION, _parseCSV: parseCSV };
})(window);
