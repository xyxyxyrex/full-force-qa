const fs = require('fs');

async function check() {
  const res = await fetch('https://staging-3ee3-pdaxwrevamp.wpcomstaging.com/how-to-invest-online-philippines/');
  const html = await res.text();
  
  console.log('--- LINK CSS TAGS ---');
  const links = html.match(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi) || [];
  links.forEach(l => console.log(l));

  console.log('--- INLINE STYLE RULES FOR CARDS ---');
  const styles = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
  styles.forEach((s, idx) => {
    if (s.includes('card-content') || s.includes('col-height') || s.includes('h3')) {
      console.log(`[STYLE BLOCK #${idx}]`, s.slice(0, 1000));
    }
  });
}

check();
