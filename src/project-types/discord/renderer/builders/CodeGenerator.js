/**
 * Discord Code Generator
 * Generates discord.js v14 and discord.py code from embed/component data
 */

/**
 * Generate embed code
 * @param {Object} embed - Embed data
 * @param {'js'|'py'} lang - Target language
 * @returns {string} Code string
 */
function generateEmbedCode(embed, lang = 'js') {
  if (lang === 'py') return generateEmbedPython(embed);
  return generateEmbedJS(embed);
}

function generateEmbedJS(embed) {
  const lines = ['const { EmbedBuilder } = require(\'discord.js\');', '', 'const embed = new EmbedBuilder()'];

  if (embed.title) lines.push(`  .setTitle(${jsStr(embed.title)})`);
  if (embed.description) lines.push(`  .setDescription(${jsStr(embed.description)})`);
  if (embed.url) lines.push(`  .setURL(${jsStr(embed.url)})`);
  if (embed.color !== undefined && embed.color !== null) {
    const c = typeof embed.color === 'string' ? embed.color : `0x${embed.color.toString(16).padStart(6, '0')}`;
    lines.push(`  .setColor(${typeof c === 'string' && c.startsWith('#') ? jsStr(c) : c})`);
  }
  if (embed.timestamp) lines.push('  .setTimestamp()');
  if (embed.thumbnail && embed.thumbnail.url) lines.push(`  .setThumbnail(${jsStr(embed.thumbnail.url)})`);
  if (embed.image && embed.image.url) lines.push(`  .setImage(${jsStr(embed.image.url)})`);

  if (embed.author) {
    const authorObj = {};
    if (embed.author.name) authorObj.name = embed.author.name;
    if (embed.author.icon_url) authorObj.iconURL = embed.author.icon_url;
    if (embed.author.url) authorObj.url = embed.author.url;
    lines.push(`  .setAuthor(${jsObj(authorObj)})`);
  }

  if (embed.footer) {
    const footerObj = {};
    if (embed.footer.text) footerObj.text = embed.footer.text;
    if (embed.footer.icon_url) footerObj.iconURL = embed.footer.icon_url;
    lines.push(`  .setFooter(${jsObj(footerObj)})`);
  }

  if (embed.fields && embed.fields.length > 0) {
    const fieldStrs = embed.fields.map(f => {
      const obj = { name: f.name || '\u200B', value: f.value || '\u200B' };
      if (f.inline) obj.inline = true;
      return jsObj(obj);
    });
    lines.push(`  .addFields(${fieldStrs.join(', ')})`);
  }

  lines[lines.length - 1] += ';';
  return lines.join('\n');
}

function generateEmbedPython(embed) {
  const lines = ['import discord', ''];

  const args = [];
  if (embed.title) args.push(`title=${pyStr(embed.title)}`);
  if (embed.description) args.push(`description=${pyStr(embed.description)}`);
  if (embed.url) args.push(`url=${pyStr(embed.url)}`);
  if (embed.color !== undefined && embed.color !== null) {
    const c = typeof embed.color === 'number' ? `0x${embed.color.toString(16).padStart(6, '0')}` : embed.color;
    args.push(`color=${typeof c === 'string' && c.startsWith('#') ? `0x${c.slice(1)}` : c}`);
  }
  if (embed.timestamp) args.push('timestamp=discord.utils.utcnow()');

  lines.push(`embed = discord.Embed(${args.join(', ')})`);

  if (embed.author) {
    const authorArgs = [];
    if (embed.author.name) authorArgs.push(`name=${pyStr(embed.author.name)}`);
    if (embed.author.icon_url) authorArgs.push(`icon_url=${pyStr(embed.author.icon_url)}`);
    if (embed.author.url) authorArgs.push(`url=${pyStr(embed.author.url)}`);
    lines.push(`embed.set_author(${authorArgs.join(', ')})`);
  }

  if (embed.thumbnail && embed.thumbnail.url) {
    lines.push(`embed.set_thumbnail(url=${pyStr(embed.thumbnail.url)})`);
  }

  if (embed.image && embed.image.url) {
    lines.push(`embed.set_image(url=${pyStr(embed.image.url)})`);
  }

  if (embed.footer) {
    const footerArgs = [];
    if (embed.footer.text) footerArgs.push(`text=${pyStr(embed.footer.text)}`);
    if (embed.footer.icon_url) footerArgs.push(`icon_url=${pyStr(embed.footer.icon_url)}`);
    lines.push(`embed.set_footer(${footerArgs.join(', ')})`);
  }

  if (embed.fields && embed.fields.length > 0) {
    for (const f of embed.fields) {
      const fieldArgs = [`name=${pyStr(f.name || '\u200B')}`, `value=${pyStr(f.value || '\u200B')}`];
      if (f.inline) fieldArgs.push('inline=True');
      lines.push(`embed.add_field(${fieldArgs.join(', ')})`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate component code
 * @param {Object[]} components - Components data (action rows)
 * @param {'js'|'py'} lang - Target language
 * @returns {string} Code string
 */
function generateComponentCode(components, lang = 'js') {
  if (lang === 'py') return generateComponentsPython(components);
  return generateComponentsJS(components);
}

function generateComponentsJS(components) {
  const lines = ['const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require(\'discord.js\');', ''];

  const STYLE_MAP = { primary: 'Primary', secondary: 'Secondary', success: 'Success', danger: 'Danger', link: 'Link' };
  const STYLE_NUM_MAP = { 1: 'Primary', 2: 'Secondary', 3: 'Success', 4: 'Danger', 5: 'Link' };

  for (let i = 0; i < components.length; i++) {
    const row = components[i];
    if (!row.components || row.components.length === 0) continue;

    const rowVar = `row${i + 1}`;
    const childLines = [];

    for (let j = 0; j < row.components.length; j++) {
      const comp = row.components[j];

      if (comp.type === 2) {
        // Button
        const styleName = STYLE_MAP[comp.style] || STYLE_NUM_MAP[comp.style] || 'Secondary';
        const btnVar = `btn${i + 1}_${j + 1}`;
        let btnLine = `const ${btnVar} = new ButtonBuilder()\n  .setStyle(ButtonStyle.${styleName})`;
        if (comp.label) btnLine += `\n  .setLabel(${jsStr(comp.label)})`;
        if (comp.custom_id) btnLine += `\n  .setCustomId(${jsStr(comp.custom_id)})`;
        if (comp.url) btnLine += `\n  .setURL(${jsStr(comp.url)})`;
        if (comp.emoji) {
          const emojiStr = typeof comp.emoji === 'string' ? comp.emoji : comp.emoji.name || '';
          if (emojiStr) btnLine += `\n  .setEmoji(${jsStr(emojiStr)})`;
        }
        if (comp.disabled) btnLine += '\n  .setDisabled(true)';
        btnLine += ';';
        lines.push(btnLine);
        childLines.push(btnVar);
      } else if (comp.type === 3) {
        // String Select
        const selVar = `select${i + 1}`;
        let selLine = `const ${selVar} = new StringSelectMenuBuilder()\n  .setCustomId(${jsStr(comp.custom_id || 'select')})`;
        if (comp.placeholder) selLine += `\n  .setPlaceholder(${jsStr(comp.placeholder)})`;
        if (comp.options && comp.options.length > 0) {
          const optStrs = comp.options.map(o => {
            const obj = { label: o.label || 'Option', value: o.value || o.label || 'option' };
            if (o.description) obj.description = o.description;
            return jsObj(obj);
          });
          selLine += `\n  .addOptions(${optStrs.join(', ')})`;
        }
        selLine += ';';
        lines.push(selLine);
        childLines.push(selVar);
      }
    }

    lines.push('');
    lines.push(`const ${rowVar} = new ActionRowBuilder().addComponents(${childLines.join(', ')});`);
    lines.push('');
  }

  return lines.join('\n');
}

function generateComponentsPython(components) {
  const lines = ['import discord', 'from discord.ui import View, Button, Select', ''];

  const STYLE_MAP = { primary: 'blurple', secondary: 'grey', success: 'green', danger: 'red', link: 'link' };
  const STYLE_NUM_MAP = { 1: 'blurple', 2: 'grey', 3: 'green', 4: 'red', 5: 'link' };

  lines.push('view = View()');

  for (const row of components) {
    if (!row.components) continue;
    for (const comp of row.components) {
      if (comp.type === 2) {
        const styleName = STYLE_MAP[comp.style] || STYLE_NUM_MAP[comp.style] || 'grey';
        const args = [`style=discord.ButtonStyle.${styleName}`];
        if (comp.label) args.push(`label=${pyStr(comp.label)}`);
        if (comp.custom_id) args.push(`custom_id=${pyStr(comp.custom_id)}`);
        if (comp.url) args.push(`url=${pyStr(comp.url)}`);
        if (comp.emoji) {
          const emojiStr = typeof comp.emoji === 'string' ? comp.emoji : comp.emoji.name || '';
          if (emojiStr) args.push(`emoji=${pyStr(emojiStr)}`);
        }
        if (comp.disabled) args.push('disabled=True');
        lines.push(`view.add_item(Button(${args.join(', ')}))`);
      } else if (comp.type === 3) {
        const args = [];
        if (comp.custom_id) args.push(`custom_id=${pyStr(comp.custom_id)}`);
        if (comp.placeholder) args.push(`placeholder=${pyStr(comp.placeholder)}`);
        lines.push(`select = Select(${args.join(', ')})`);
        if (comp.options) {
          for (const o of comp.options) {
            const optArgs = [`label=${pyStr(o.label || 'Option')}`, `value=${pyStr(o.value || o.label || 'option')}`];
            if (o.description) optArgs.push(`description=${pyStr(o.description)}`);
            lines.push(`select.add_option(${optArgs.join(', ')})`);
          }
        }
        lines.push('view.add_item(select)');
      }
    }
  }

  return lines.join('\n');
}

// ========== Helpers ==========

function jsStr(s) {
  if (s === undefined || s === null) return "''";
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
}

function pyStr(s) {
  if (s === undefined || s === null) return "''";
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
}

function jsObj(obj) {
  const entries = Object.entries(obj).map(([k, v]) => {
    if (typeof v === 'boolean') return `${k}: ${v}`;
    if (typeof v === 'number') return `${k}: ${v}`;
    return `${k}: ${jsStr(v)}`;
  });
  return `{ ${entries.join(', ')} }`;
}

module.exports = {
  generateEmbedCode,
  generateComponentCode
};
