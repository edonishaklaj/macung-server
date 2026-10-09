// Kent / Maçung hand check. Same code as the game (src/App.jsx in edonishaklaj/macung,
// "HAND ANALYSIS"), so the server accepts exactly the hands the game shows as winning.
const VALUE_ORDER = {A:1,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,J:11,Q:12,K:13};
function numVal(c){return c.isJoker?0:(VALUE_ORDER[c.value]||0);}

function buildMelds(hand){
  const nj   = hand.filter(c=>!c.isJoker);
  const jkrs = hand.filter(c=>c.isJoker);
  const jkCount = jkrs.length;

  // All valid series (with joker gaps), A can be low (1) or high (14)
  const bySuit={};
  nj.forEach(c=>{ (bySuit[c.suit]=bySuit[c.suit]||[]).push(c); });
  const allSeries=[];

  function findRunsInSorted(sorted, jkCount){
    const runs=[];
    for(let si=0;si<sorted.length;si++){
      const run=[sorted[si]]; let jUsed=0;
      for(let ei=si+1;ei<sorted.length;ei++){
        const gap=sorted[ei].rv - sorted[ei-1].rv - 1;
        if(gap<0) break;
        if(gap>0){ if(jUsed+gap<=jkCount) jUsed+=gap; else break; }
        run.push(sorted[ei]);
        if(run.length+jUsed>=3) runs.push({cards:run.map(x=>x.card),jUsed,type:"series"});
      }
      // Also try extending run with joker(s) AFTER last card (e.g. 9-10 + JOKER = 9-10-J)
      const remainingJokers = jkCount - jUsed;
      if(remainingJokers > 0 && run.length >= 2){
        for(let extra=1; extra<=remainingJokers; extra++){
          const totalLen = run.length + jUsed + extra;
          if(totalLen >= 3){
            runs.push({cards:run.map(x=>x.card), jUsed: jUsed+extra, type:"series"});
          }
        }
      }
    }
    return runs;
  }

  for(const cs of Object.values(bySuit)){
    // Group by rank — keep ALL copies (two 5♥ = two separate series candidates)
    const byRankMap={};
    cs.forEach(c=>{
      const rv=numVal(c);
      if(!byRankMap[rv]) byRankMap[rv]=[];
      byRankMap[rv].push(c);
    });

    // Generate all combinations when duplicates exist
    // For each rank with N copies, we need to try each copy as the representative
    const ranks=Object.keys(byRankMap).map(Number).sort((a,b)=>a-b);

    // Build all possible "pick one per rank" combinations (capped to avoid explosion)
    function buildCombos(rIdx, current){
      if(rIdx>=ranks.length) return [current];
      const rv=ranks[rIdx];
      const copies=byRankMap[rv];
      const results=[];
      // Try each unique copy (max 2 copies per rank)
      const tried=new Set();
      for(const card of copies){
        if(tried.has(card.id)) continue;
        tried.add(card.id);
        buildCombos(rIdx+1,[...current,{card,rv}]).forEach(r=>results.push(r));
      }
      return results;
    }
    const combos=buildCombos(0,[]);
    // Also generate "last-copy" combo to ensure second physical copies are tried
    const lastCopyCombos=ranks.map(rv=>byRankMap[rv][byRankMap[rv].length-1]).map((card,i)=>({card,rv:ranks[i]}));
    const allCombos=[...combos, lastCopyCombos].slice(0,8);
    const limitedCombos=allCombos;

    for(const sorted1 of limitedCombos){
      // A=14 high FIRST — so J-Q-K-A gets priority over A-2-3
      const hasAce=sorted1.some(x=>x.rv===1);
      if(hasAce){
        const sorted2=sorted1.map(x=>({...x,rv:x.rv===1?14:x.rv})).sort((a,b)=>a.rv-b.rv);
        findRunsInSorted(sorted2,jkCount).forEach(r=>allSeries.push(r));
      }
      // A=1 low after
      findRunsInSorted(sorted1,jkCount).forEach(r=>allSeries.push(r));
    }
  }

  // All valid groups (with joker)
  const byVal={};
  nj.forEach(c=>{ (byVal[c.value]=byVal[c.value]||[]).push(c); });
  const allGroups=[];
  for(const cs of Object.values(byVal)){
    const bySuitG={};
    cs.forEach(c=>{ if(!bySuitG[c.suit]) bySuitG[c.suit]=c; });
    const uniq=Object.values(bySuitG);
    if(uniq.length>=4){
      allGroups.push({cards:uniq.slice(0,4),jUsed:0,type:"group"});
      // Add all 3-card subgroups C(4,3)=4 so backtracking finds optimal
      for(let skip=0;skip<4;skip++){
        allGroups.push({cards:uniq.filter((_,i)=>i!==skip),jUsed:0,type:"group"});
      }
    } else if(uniq.length===3){
      allGroups.push({cards:uniq,jUsed:0,type:"group"});
    } else if(uniq.length===2&&jkCount>=1){
      allGroups.push({cards:uniq,jUsed:1,type:"group"});
    }
  }

  // Single backtracking — try ALL melds in order, both use and skip
  // Sort by size desc — LONGER melds first ensures 10-J-Q-K-A (5) beats J×3 (3)
  const allMelds=[...allGroups,...allSeries].sort((a,b)=>{
    const sa=a.cards.length+(a.jUsed||0);
    const sb=b.cards.length+(b.jUsed||0);
    if(sb!==sa) return sb-sa; // longer first
    // Tie: groups before series (groups are more restrictive — unique suits required)
    if(a.type!==b.type) return a.type==="group"?-1:1;
    return 0;
  });
  const limited=allMelds.slice(0,100);

  let bestScore=0, bestAssign=null;

  function solve(idx, usedReal, jUsedTotal, assign){
    const score=usedReal.size+jUsedTotal;
    if(score>bestScore){ bestScore=score; bestAssign=assign.map(m=>({...m})); }
    if(idx>=limited.length) return;
    const m=limited[idx];
    const realFree=m.cards.filter(c=>!usedReal.has(c.id));
    // Try USING this meld (only if all cards are free)
    if(realFree.length===m.cards.length && jUsedTotal+m.jUsed<=jkCount){
      realFree.forEach(c=>usedReal.add(c.id));
      assign.push({...m, cards:realFree});
      solve(idx+1, usedReal, jUsedTotal+m.jUsed, assign);
      assign.pop();
      realFree.forEach(c=>usedReal.delete(c.id));
    }
    // Always also try SKIPPING this meld (crucial for finding alternatives)
    solve(idx+1, usedReal, jUsedTotal, assign);
  }

  solve(0, new Set(), 0, []);
  return {melds: bestAssign||[], jkrs, jkCount, score:bestScore};
}

// Position-based analysis: scans hand left-to-right for consecutive valid melds
function analyzeHandByPosition(hand){
  const n = hand.length;
  const inGroup = new Set();
  const inSeries = new Set();
  const used = new Set();

  function isValidSeries(nonJokers, jokerCount){
    if(nonJokers.length < 2) return false;
    const suits = new Set(nonJokers.map(c=>c.suit));
    if(suits.size !== 1) return false;
    // Try A=1 low
    const sorted1 = [...nonJokers].sort((a,b)=>numVal(a)-numVal(b));
    let gaps1 = 0, dup1 = false;
    for(let i=1;i<sorted1.length;i++){
      const g = numVal(sorted1[i]) - numVal(sorted1[i-1]) - 1;
      if(g < 0){ dup1=true; break; }
      gaps1 += g;
    }
    if(!dup1 && gaps1 <= jokerCount) return true;
    // Try A=14 high
    const hasAce = nonJokers.some(c=>c.value==="A");
    if(hasAce){
      const sorted2 = [...nonJokers].sort((a,b)=>{
        const va=a.value==="A"?14:numVal(a);
        const vb=b.value==="A"?14:numVal(b);
        return va-vb;
      });
      let gaps2=0, dup2=false;
      for(let i=1;i<sorted2.length;i++){
        const va=sorted2[i-1].value==="A"?14:numVal(sorted2[i-1]);
        const vb=sorted2[i].value==="A"?14:numVal(sorted2[i]);
        const g = vb - va - 1;
        if(g < 0){ dup2=true; break; }
        gaps2 += g;
      }
      if(!dup2 && gaps2 <= jokerCount) return true;
    }
    return false;
  }

  // Scan for series first
  for(let start=0; start<n; start++){
    for(let len=n-start; len>=3; len--){
      const window = hand.slice(start, start+len);
      if(window.some(c=>used.has(c.id))) continue;
      const nonJokers = window.filter(c=>!c.isJoker);
      const jokers = window.filter(c=>c.isJoker);
      if(nonJokers.length + jokers.length < 3) continue;
      if(isValidSeries(nonJokers, jokers.length)){
        window.forEach(c=>{ inSeries.add(c.id); used.add(c.id); });
        break;
      }
    }
  }

  // Scan for groups
  for(let start=0; start<n; start++){
    for(let len=Math.min(4, n-start); len>=3; len--){
      const window = hand.slice(start, start+len);
      if(window.some(c=>used.has(c.id))) continue;
      const nonJokers = window.filter(c=>!c.isJoker);
      const jokers = window.filter(c=>c.isJoker);
      const vals = new Set(nonJokers.map(c=>c.value));
      if(vals.size !== 1) continue;
      const suits = new Set(nonJokers.map(c=>c.suit));
      if(suits.size !== nonJokers.length) continue;
      if(nonJokers.length + jokers.length >= 3){
        window.forEach(c=>{ inGroup.add(c.id); used.add(c.id); });
        break;
      }
    }
  }

  return hand.map(c=>({...c,
    inGroup: inGroup.has(c.id),
    inSeries: inSeries.has(c.id) && !inGroup.has(c.id)
  }));
}

function findBestMelds(hand){
  // Try both group-first and series-first, return best
  const r1 = buildMelds(hand);          // groups-first
  const r2 = buildMeldsSeriesFirst(hand); // series-first
  return r1.score >= r2.score ? r1 : r2;
}

function buildMeldsSeriesFirst(hand){
  const nj=hand.filter(c=>!c.isJoker), jkrs=hand.filter(c=>c.isJoker), jkCount=jkrs.length;
  const bySuit={};
  nj.forEach(c=>{(bySuit[c.suit]=bySuit[c.suit]||[]).push(c);});
  const allSeries=[];
  function findR(sorted,jkc){
    const runs=[];
    for(let si=0;si<sorted.length;si++){
      const run=[sorted[si]];let ju=0;
      for(let ei=si+1;ei<sorted.length;ei++){
        const gap=sorted[ei].rv-sorted[ei-1].rv-1;
        if(gap<0)break;if(gap>0){if(ju+gap<=jkc)ju+=gap;else break;}
        run.push(sorted[ei]);
        if(run.length+ju>=3)runs.push({cards:run.map(x=>x.card),jUsed:ju,type:"series"});
      }
      const rem=jkc-ju;
      if(rem>0&&run.length>=2)for(let ex=1;ex<=rem;ex++)if(run.length+ju+ex>=3)runs.push({cards:run.map(x=>x.card),jUsed:ju+ex,type:"series"});
    }
    return runs;
  }
  for(const cs of Object.values(bySuit)){
    const brm={};cs.forEach(c=>{const rv=numVal(c);if(!brm[rv])brm[rv]=[];brm[rv].push(c);});
    const ranks=Object.keys(brm).map(Number).sort((a,b)=>a-b);
    function bc(rIdx,cur){if(rIdx>=ranks.length)return[cur];const rv=ranks[rIdx],copies=brm[rv],res=[],tried=new Set();for(const card of copies){if(tried.has(card.id))continue;tried.add(card.id);bc(rIdx+1,[...cur,{card,rv}]).forEach(r=>res.push(r));}return res;}
    for(const s1 of bc(0,[]).slice(0,8)){
      const hasA=s1.some(x=>x.rv===1);
      if(hasA){const s2=s1.map(x=>({...x,rv:x.rv===1?14:x.rv})).sort((a,b)=>a.rv-b.rv);findR(s2,jkCount).forEach(r=>allSeries.push(r));}
      findR(s1,jkCount).forEach(r=>allSeries.push(r));
    }
  }
  const byVal={};nj.forEach(c=>{(byVal[c.value]=byVal[c.value]||[]).push(c);});
  const allGroups=[];
  for(const cs of Object.values(byVal)){
    const bsg={};cs.forEach(c=>{if(!bsg[c.suit])bsg[c.suit]=c;});
    const uniq=Object.values(bsg);
    if(uniq.length>=4){ allGroups.push({cards:uniq.slice(0,4),jUsed:0,type:"group"}); for(let skip=0;skip<4;skip++) allGroups.push({cards:uniq.filter((_,i)=>i!==skip),jUsed:0,type:"group"}); } else if(uniq.length===3){ allGroups.push({cards:uniq,jUsed:0,type:"group"}); }
    if(uniq.length===2&&jkCount>=1)allGroups.push({cards:uniq,jUsed:1,type:"group"});
  }
  // Series-first sort
  const allMelds=[...allSeries,...allGroups].sort((a,b)=>{
    const sa=a.cards.length+(a.jUsed||0),sb=b.cards.length+(b.jUsed||0);
    if(sb!==sa)return sb-sa;
    return a.type==="series"?-1:1;
  }).slice(0,100);
  let bestScore=0, bestMelds=[];
  function solve(idx,used,ju,score,melds){
    if(score>bestScore){bestScore=score;bestMelds=[...melds];}
    if(idx>=allMelds.length)return;
    const m=allMelds[idx];
    const rf=m.cards.filter(c=>!used.has(c.id));
    if(rf.length===m.cards.length&&ju+m.jUsed<=jkCount){
      rf.forEach(c=>used.add(c.id));
      solve(idx+1,used,ju+m.jUsed,score+rf.length+m.jUsed,[...melds,m]);
      rf.forEach(c=>used.delete(c.id));
    }
    solve(idx+1,used,ju,score,melds);
  }
  solve(0,new Set(),0,0,[]);
  return {score:bestScore, melds:bestMelds};
}

// Count highlighted cards using BOTH visual position and algorithmic methods
function countHighlighted(hand){
  // Method 1: position-based (what user sees)
  const byPos = analyzeHandByPosition(hand);
  const posCount = byPos.filter(c=>c.inGroup||c.inSeries).length;
  // Method 2: algorithmic best score
  const {score} = findBestMelds(hand);
  return Math.max(posCount, score);
}

// Check if hand has at least one meld with 4+ cards (4-ling, 5-ling, etc.)
function hasLongMeld(hand){
  const {melds} = findBestMelds(hand);
  if(melds.some(m=>(m.cards.length+(m.jUsed||0))>=4)) return true;
  // Group consecutive highlighted cards per suit (series) or same value (group)
  // Simple check: if buildMelds returns any 4+ meld
  const r2 = buildMeldsSeriesFirst(hand);
  return r2.melds && r2.melds.some(m=>(m.cards.length+(m.jUsed||0))>=4);
}

function isMacung(hand){
  if(hand.length!==15) return false;
  const highlighted = countHighlighted(hand);
  if(highlighted<15) return false;
  return hasLongMeld(hand);
}

function isKent(hand){
  if(hand.length!==15) return false;
  if(isMacung(hand)) return false;
  const highlighted = countHighlighted(hand);
  return highlighted>=14 && hasLongMeld(hand);
}

module.exports = { isKent, isMacung, countHighlighted, hasLongMeld };
