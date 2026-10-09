const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { isKent, isMacung } = require("./handCheck");
const { verifyUser, applyChips } = require("./chips");

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

// ── EMAIL SETUP (optional) ───────────────────────────────────────────────────
let transporter = null;
try{
  const nodemailer = require("nodemailer");
  if(process.env.EMAIL_USER && process.env.EMAIL_PASS){
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
  }
}catch(e){ console.log("nodemailer not available"); }

app.post("/send-welcome", async(req,res)=>{
  const {name, email} = req.body;
  if(!transporter||!email||!name){ res.json({ok:false}); return; }
  try{
    await transporter.sendMail({
      from: `"Maçung 🃏" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Mirë se vjen në Maçung! 🃏",
      html: `
        <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;background:#0a0000;color:#e8d5d5;padding:30px;border-radius:12px;">
          <h1 style="color:#ff4444;text-align:center;letter-spacing:3px;">♠ MAÇUNG ♠</h1>
          <p style="font-size:18px;color:#ffd700;">Mirë se vjen, ${name}! 🎉</p>
          <p style="color:#c08080;">Accounts yt u krijua me sukses. Tani mund të luash online me miqtë!</p>
          <div style="background:rgba(255,68,68,0.1);border:1px solid #ff444444;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0;color:#888;font-size:13px;">Email i regjistrimit:</p>
            <p style="margin:4px 0 0;color:#ff4444;font-weight:700;">${email}</p>
          </div>
          <p style="color:#666;font-size:12px;text-align:center;">Loja: <a href="https://macung.vercel.app" style="color:#ff4444;">macung.vercel.app</a></p>
        </div>
      `,
    });
    res.json({ok:true});
  }catch(e){
    console.error("Email error:",e.message);
    res.json({ok:false});
  }
});

// ── ONESIGNAL PUSH (optional) ────────────────────────────────────────────────
// Env vars në Render: ONESIGNAL_APP_ID + ONESIGNAL_REST_API_KEY
async function sendPush(emails, title, message){
  if(!process.env.ONESIGNAL_APP_ID||!process.env.ONESIGNAL_REST_API_KEY) return;
  const targets=(emails||[]).filter(Boolean).map(e=>e.toLowerCase());
  if(targets.length===0) return;
  try{
    await fetch("https://api.onesignal.com/notifications",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":`Basic ${process.env.ONESIGNAL_REST_API_KEY}`
      },
      body:JSON.stringify({
        app_id:process.env.ONESIGNAL_APP_ID,
        include_aliases:{external_id:targets},
        target_channel:"push",
        headings:{en:title},
        contents:{en:message},
        url:"https://macung.com"
      })
    });
  }catch(e){ console.log("Push error:",e.message); }
}

const rooms = {};

function makeCode(){
  return Math.random().toString(36).substring(2,6).toUpperCase();
}

function getRoomBySocket(sid){
  return Object.values(rooms).find(r=>
    r.players.some(p=>p.id===sid)||r.pending.some(p=>p.id===sid)
  );
}

const SUITS=["♠","♥","♦","♣"];
const VALUES=["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function createDeck(){
  const d=[];
  for(let c=0;c<2;c++){
    for(const s of SUITS) for(const v of VALUES)
      d.push({id:`${v}${s}_${c}`,value:v,suit:s,isJoker:false});
    d.push({id:`JK_${c}`,value:"★",suit:"★",isJoker:true});
  }
  return shuffle(d);
}

function shuffle(a){
  const b=[...a];
  for(let i=b.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [b[i],b[j]]=[b[j],b[i]];
  }
  return b;
}

// Clockwise next seat: 0→3→2→1→0
function nextSeat(cur, activeSet){
  for(let i=1;i<=4;i++){
    const s=(cur+4-i)%4;
    if(activeSet.has(s)) return s;
  }
  return cur;
}

const TABLES=[
  {id:1,surrender:50,kent:100,macung:200},     // €0.50 / €1 / €2
  {id:2,surrender:100,kent:200,macung:400},    // €1 / €2 / €4
  {id:3,surrender:200,kent:500,macung:1000},   // €2 / €5 / €10
  {id:4,surrender:500,kent:1000,macung:2000},  // €5 / €10 / €20
  {id:5,surrender:1000,kent:2000,macung:4000}, // €10 / €20 / €40
];

function newRoom(tableId){
  return {
    tableId,
    players:[],
    pending:[],
    deck:[],discard:[],
    playerDiscards:{0:[],1:[],2:[],3:[]},
    current:0,dealer:0,
    host:0,                 // seat that starts the game (the creator; passes on if they leave before the start)
    phase:"waiting",hasDrawn:false,
    roundNum:1,
    scores:{0:0,1:0,2:0,3:0},
    started:false,
    surrendered:new Set(),  // seats out of the current round (dorëzim)
    drawnSeats:new Set(),   // seats that already drew this round (no surrender after that)
    surrenderFees:{},
    surrenderPot:0,         // fees paid this round, go to the round winner
  };
}

// Next dealer: the seat that plays right after the current dealer (same
// direction as the turns, 0→3→2→1), among next round's players (current +
// pending), skipping empty seats. Doesn't depend on who won the round.
function nextDealerSeat(r){
  const seats=new Set([...r.players,...r.pending].map(p=>p.seat));
  let d=(r.dealer+3)%4;
  for(let i=0;i<4&&!seats.has(d);i++) d=(d+3)%4;
  return d;
}
function nextDealerInfo(r){
  const seat=nextDealerSeat(r);
  const p=[...r.players,...r.pending].find(x=>x.seat===seat);
  return {nextDealer:seat,nextDealerName:p?p.name:""};
}

// The player's cards in the order shown on their screen (localHand), using the
// server's own cards. For Kent the game sets the free card aside before sending,
// so cards missing from localHand go at the end. null = a card they don't hold.
function orderedHand(p, localHand){
  const byId=new Map(p.hand.map(c=>[c.id,c]));
  const seen=new Set(), out=[];
  for(const c of Array.isArray(localHand)?localHand:[]){
    const card=c&&byId.get(c.id);
    if(!card||seen.has(card.id)) return null;
    seen.add(card.id); out.push(card);
  }
  p.hand.forEach(c=>{ if(!seen.has(c.id)) out.push(c); });
  return out;
}

// Seats still playing the current round
function activeSeats(r){
  return new Set(r.players.map(p=>p.seat).filter(s=>!r.surrendered.has(s)));
}

function roomInfo(code){
  const r=rooms[code];
  return {
    code,
    tableId:r.tableId,
    started:r.started,
    host:r.host,
    players:r.players.map(p=>({seat:p.seat,name:p.name,cardCount:p.hand.length})),
    pending:r.pending.map(p=>({seat:p.seat,name:p.name})),
  };
}

function broadcast(code){
  const r=rooms[code];
  const state={
    code,
    tableId:r.tableId,
    current:r.current,
    dealer:r.dealer,
    phase:r.phase,
    hasDrawn:r.hasDrawn,
    roundNum:r.roundNum,
    scores:r.scores,
    discard:r.discard,
    playerDiscards:r.playerDiscards,
    deckCount:r.deck.length,
    players:r.players.map(p=>({seat:p.seat,name:p.name,cardCount:p.hand.length})),
    playerCount:r.players.length,
    surrendered:[...r.surrendered],
    drawnSeats:[...r.drawnSeats],
  };
  io.to(code).emit("gameUpdate",state);
  r.players.forEach(p=>io.to(p.id).emit("yourHand",{hand:p.hand}));
}

function dealRound(code){
  const r=rooms[code];
  r.started=true;
  r.deck=createDeck();
  r.discard=[];
  r.playerDiscards={0:[],1:[],2:[],3:[]};
  r.hasDrawn=true;
  r.roundEnded=false;
  r.surrendered=new Set();
  r.drawnSeats=new Set();
  r.surrenderFees={};
  r.surrenderPot=0;
  r.players.forEach(p=>{p.hand=[];});

  const ds=r.dealer;
  [...r.players].sort((a,b)=>a.seat-b.seat).forEach(p=>{
    const n=p.seat===ds?15:14;
    for(let i=0;i<n;i++) p.hand.push(r.deck.shift());
  });

  // Dealer starts with 15 cards and must discard first
  r.phase="discard";
  r.current=ds;

  broadcast(code);
}

// Pays the round: every active loser pays val, surrendered players already paid
// their fee (surrenderPot). The winner collects both. Returns {seat: +/-chips}.
function settleRound(r, winnerSeat, val){
  const payments={};
  let gain=r.surrenderPot;
  r.players.forEach(x=>{
    if(x.seat===winnerSeat) return;
    if(r.surrendered.has(x.seat)){ payments[x.seat]=-(r.surrenderFees[x.seat]||0); return; }
    r.scores[x.seat]+=val;
    payments[x.seat]=-val;
    gain+=val;
  });
  r.scores[winnerSeat]-=gain;
  payments[winnerSeat]=gain;
  // Save to the accounts; surrendered players were already charged when they surrendered
  r.players.forEach(x=>{ if(!r.surrendered.has(x.seat)) payAccount(x, payments[x.seat]); });
  r.roundEnded=true;
  r.phase="ended";
  return payments;
}

// Saves a player's chips change to their account (guests: nothing saved)
// and sends them the new balance
function payAccount(p, delta){
  if(!p||!p.userId||!delta) return;
  applyChips(p.userId, delta).then(balance=>{
    if(balance!==null) io.to(p.id).emit("balanceUpdate",{balance});
  });
}

// Everyone else surrendered → the last player wins the round and takes the fees
function endRoundBySurrender(code, winnerSeat){
  const r=rooms[code];
  const w=r.players.find(x=>x.seat===winnerSeat);
  const payments=settleRound(r, winnerSeat, 0);
  r.current=winnerSeat;
  broadcast(code);
  io.to(code).emit("gameFinished",{
    type:"surrender",winner:winnerSeat,val:0,
    winnerName:w?w.name:"",
    winnerHand:[],
    scores:r.scores,
    playerCount:r.players.length,
    payments,
    surrendered:[...r.surrendered],
    ...nextDealerInfo(r),
  });
}

io.on("connection",(socket)=>{
  console.log("Connected:",socket.id);

  socket.on("createRoom",async({playerName,tableId,email,accessToken},cb)=>{
    const userId=await verifyUser(accessToken);
    const code=makeCode();
    rooms[code]=newRoom(tableId);
    rooms[code].code=code;
    rooms[code].players.push({id:socket.id,name:playerName,seat:0,hand:[],email:email||null,userId});
    socket.join(code);
    cb({code,seat:0,pending:false});
    io.to(code).emit("roomUpdate",roomInfo(code));
  });

  socket.on("joinRoom",async({playerName,code,email,accessToken},cb)=>{
    const userId=await verifyUser(accessToken);
    const r=rooms[code];
    if(!r){cb({error:"Dhoma nuk ekziston"});return;}
    const total=r.players.length+r.pending.length;
    if(total>=4){cb({error:"Dhoma është e plotë"});return;}

    const taken=[...r.players,...r.pending].map(p=>p.seat);
    const seat=[0,1,2,3].find(s=>!taken.includes(s));

    // Notify existing players (push shows only if they're away from the tab)
    const existingEmails=r.players.map(p=>p.email).filter(Boolean);
    sendPush(existingEmails,"Maçung 🃏",`${playerName} hyri në dhomën ${code}!`);

    if(r.started){
      r.pending.push({id:socket.id,name:playerName,seat,hand:[],email:email||null,userId});
      socket.join(code);
      cb({code,seat,pending:true});
      socket.emit("waitingForRound",{message:"⏳ Duke pritur fundin e raundeve..."});
    } else {
      r.players.push({id:socket.id,name:playerName,seat,hand:[],email:email||null,userId});
      socket.join(code);
      cb({code,seat,pending:false});
    }
    io.to(code).emit("roomUpdate",roomInfo(code));
  });

  socket.on("findRoom",async({playerName,tableId,email,accessToken},cb)=>{
    const userId=await verifyUser(accessToken);
    const open=Object.values(rooms).find(r=>
      !r.started&&r.tableId===tableId&&(r.players.length+r.pending.length)<4
    );
    if(open){
      const taken=open.players.map(p=>p.seat);
      const seat=[0,1,2,3].find(s=>!taken.includes(s));
      // Notify existing players
      const existingEmails=open.players.map(p=>p.email).filter(Boolean);
      sendPush(existingEmails,"Maçung 🃏",`${playerName} hyri në dhomën ${open.code}!`);
      open.players.push({id:socket.id,name:playerName,seat,hand:[],email:email||null,userId});
      socket.join(open.code);
      cb({code:open.code,seat,pending:false});
      io.to(open.code).emit("roomUpdate",roomInfo(open.code));
    } else {
      const code=makeCode();
      rooms[code]=newRoom(tableId);
      rooms[code].code=code;
      rooms[code].players.push({id:socket.id,name:playerName,seat:0,hand:[],email:email||null,userId});
      socket.join(code);
      cb({code,seat:0,pending:false});
      io.to(code).emit("roomUpdate",roomInfo(code));
    }
  });

  socket.on("startGame",({code})=>{
    const r=rooms[code];
    if(!r||r.started) return;
    const p=r.players.find(p=>p.id===socket.id);
    if(!p||p.seat!==r.host) return;
    if(r.players.length<2){socket.emit("error","Duhen të paktën 2 lojtarë");return;}
    r.dealer=r.host; // the room's creator deals the first round
    dealRound(code);
  });

  socket.on("drawDeck",({code})=>{
    const r=rooms[code];
    if(!r||!r.started||r.roundEnded) return;
    const p=r.players.find(p=>p.id===socket.id);
    if(!p||r.surrendered.has(p.seat)) return;
    if(r.current!==p.seat||r.phase!=="draw"||r.hasDrawn) return;
    if(r.deck.length===0){
      if(r.discard.length<=1) return;
      const top=r.discard.pop();r.deck=shuffle(r.discard);r.discard=[top];
    }
    const card=r.deck.shift();
    p.hand.push(card);
    r.hasDrawn=true;r.phase="discard";
    r.drawnSeats.add(p.seat);
    broadcast(code);
  });

  socket.on("drawDiscard",({code})=>{
    const r=rooms[code];
    if(!r||!r.started||r.roundEnded) return;
    const p=r.players.find(p=>p.id===socket.id);
    if(!p||r.surrendered.has(p.seat)) return;
    if(r.current!==p.seat||r.phase!=="draw"||r.hasDrawn||r.discard.length===0) return;
    const card=r.discard.pop();
    p.hand.push(card);
    r.playerDiscards[p.seat]=r.playerDiscards[p.seat].filter(c=>c.id!==card.id);
    r.hasDrawn=true;r.phase="discard";
    r.drawnSeats.add(p.seat);
    broadcast(code);
  });

  socket.on("discardCard",({code,cardIdx,cardId})=>{
    const r=rooms[code];
    if(!r||!r.started||r.roundEnded) return;
    const p=r.players.find(p=>p.id===socket.id);
    if(!p||r.surrendered.has(p.seat)) return;
    if(r.current!==p.seat||r.phase!=="discard") return;
    // Find by cardId first (more reliable), fallback to cardIdx
    let card;
    if(cardId){
      const idx=p.hand.findIndex(c=>c.id===cardId);
      if(idx===-1) return;
      card=p.hand.splice(idx,1)[0];
    } else {
      card=p.hand.splice(cardIdx,1)[0];
    }
    if(!card) return;
    // STRICT: never allow Joker discard
    if(card.isJoker){
      p.hand.push(card); // put it back
      return;
    }
    r.discard.push(card);
    r.playerDiscards[p.seat].push(card);
    r.current=nextSeat(r.current,activeSeats(r));
    r.phase="draw";r.hasDrawn=false;
    broadcast(code);
  });

  // Dorëzim: only on the player's own turn, before their first draw of the round
  // (the dealer's first draw comes after his opening discard). The player pays
  // the table's surrender fee and sits out until the next round.
  socket.on("surrender",({code})=>{
    const r=rooms[code];
    if(!r||!r.started||r.roundEnded) return;
    const p=r.players.find(p=>p.id===socket.id);
    if(!p||r.current!==p.seat||r.phase!=="draw"||r.hasDrawn) return;
    if(r.drawnSeats.has(p.seat)||r.surrendered.has(p.seat)) return;
    const table=TABLES.find(t=>t.id===r.tableId)||TABLES[0];
    r.surrendered.add(p.seat);
    r.surrenderFees[p.seat]=table.surrender;
    r.surrenderPot+=table.surrender;
    r.scores[p.seat]+=table.surrender;
    payAccount(p, -table.surrender);
    io.to(code).emit("playerSurrendered",{seat:p.seat,name:p.name,fee:table.surrender});
    const active=activeSeats(r);
    if(active.size===1){ endRoundBySurrender(code,[...active][0]); return; }
    r.current=nextSeat(p.seat,active);
    r.phase="draw";r.hasDrawn=false;
    broadcast(code);
  });

  socket.on("finishGame",({code,type,localHand})=>{
    const r=rooms[code];
    if(!r||!r.started||r.roundEnded) return; // a round is paid only once
    const p=r.players.find(p=>p.id===socket.id);
    if(!p||r.surrendered.has(p.seat)) return;
    const kind=type==="macung"?"macung":"kent";
    // Only on the player's own turn with 15 cards (after drawing, before
    // discarding), and only with a hand that really is Maçung / Kent
    const hand=orderedHand(p, localHand);
    const valid=r.current===p.seat&&r.phase==="discard"&&p.hand.length===15&&hand&&
      (kind==="macung"?isMacung(hand):(isKent(hand)||isMacung(hand)));
    if(!valid){
      socket.emit("finishRejected",{message:kind==="macung"?"❌ Dora nuk është Maçung":"❌ Dora nuk është Kënt"});
      broadcast(code); // puts back what the player's screen already changed (e.g. the card set aside for Kent)
      return;
    }
    const table=TABLES.find(t=>t.id===r.tableId)||TABLES[0];
    const val=table[kind];
    const n=r.players.length;
    const shown=Array.isArray(localHand)&&localHand.length>0?hand.slice(0,localHand.length):p.hand;
    // Round is over → votes for next round are now allowed (settleRound sets roundEnded)
    const payments=settleRound(r, p.seat, val);
    io.to(code).emit("gameFinished",{
      type:kind,winner:p.seat,val,
      winnerName:p.name,
      winnerHand: shown,
      scores:r.scores,
      playerCount:n,
      payments,
      surrendered:[...r.surrendered],
      ...nextDealerInfo(r),
    });
  });

  socket.on("newRound",({code})=>{
    const r=rooms[code];
    if(!r) return;
    // Only accept votes after the round actually ended (gameFinished)
    if(!r.roundEnded) return;
    // If a round is already being dealt, ignore
    if(r.roundStarting) return;

    // Initialize vote tracking for this round-end
    if(!r.readyVotes) r.readyVotes=new Set();
    const p=r.players.find(x=>x.id===socket.id);
    if(p) r.readyVotes.add(p.seat);

    // Tell everyone how many are ready (for UI: "2/3 gati")
    io.to(code).emit("readyUpdate",{
      ready:r.readyVotes.size,
      total:r.players.length,
    });

    // Start a 30s fallback timer the first time someone votes
    if(!r.readyTimer){
      r.readyTimer=setTimeout(()=>{ startNextRound(code); }, 30000);
    }

    // If everyone has voted, start immediately
    if(r.readyVotes.size>=r.players.length){
      startNextRound(code);
    }
  });

  function startNextRound(code){
    const r=rooms[code];
    if(!r) return;
    if(r.roundStarting) return;
    r.roundStarting=true;
    r.roundEnded=false; // votes closed until next gameFinished
    // Clear vote state + timer
    if(r.readyTimer){ clearTimeout(r.readyTimer); r.readyTimer=null; }
    r.readyVotes=new Set();
    setTimeout(()=>{ if(r) r.roundStarting=false; },3000);

    // Merge pending into active
    if(r.pending.length>0){
      r.pending.forEach(p=>r.players.push(p));
      r.pending=[];
    }
    // Exactly one rotation per round (startNextRound runs once per round end)
    r.dealer=nextDealerSeat(r);
    r.roundNum++;
    io.to(code).emit("roomUpdate",roomInfo(code));
    dealRound(code);
  }

  socket.on("disconnect",()=>{
    const r=getRoomBySocket(socket.id);
    if(!r) return;
    // Capture who left BEFORE removing them
    const leaver=r.players.find(p=>p.id===socket.id);
    const leaverName=leaver?leaver.name:"Lojtari";
    const leaverSeat=leaver?leaver.seat:null;
    r.players=r.players.filter(p=>p.id!==socket.id);
    r.pending=r.pending.filter(p=>p.id!==socket.id);
    if(r.players.length===0&&r.pending.length===0){
      if(r.readyTimer){ clearTimeout(r.readyTimer); r.readyTimer=null; }
      delete rooms[r.code];
    } else {
      // The creator left before the start → the next player in turn order (0→3→2→1) can start the game
      if(!r.started&&leaverSeat===r.host){
        const seats=new Set(r.players.map(p=>p.seat));
        let h=(leaverSeat+3)%4;
        for(let i=0;i<4&&!seats.has(h);i++) h=(h+3)%4;
        r.host=h;
      }
      io.to(r.code).emit("playerLeft",{name:leaverName});
      io.to(r.code).emit("roomUpdate",roomInfo(r.code));
      if(r.started&&r.players.length<2){
        // Only 1 player remains → game can't continue
        io.to(r.code).emit("gameEnded",{message:`❌ ${leaverName} doli — loja mbaroi`});
      } else if(r.started&&!r.roundEnded&&activeSeats(r).size===1){
        // Everyone still in the round left or surrendered → last player wins it
        endRoundBySurrender(r.code,[...activeSeats(r)][0]);
      } else if(r.started&&!r.roundEnded&&leaverSeat!==null&&r.current===leaverSeat){
        // It was the leaver's turn → pass turn to next active player so game doesn't hang
        r.current=nextSeat(r.current,activeSeats(r));
        r.phase="draw"; r.hasDrawn=false;
        broadcast(r.code);
      }
      // If a vote was in progress and remaining players have all voted, start now
      if(r.readyVotes&&r.readyVotes.size>0){
        const activeSeats=new Set(r.players.map(p=>p.seat));
        r.readyVotes=new Set([...r.readyVotes].filter(s=>activeSeats.has(s)));
        io.to(r.code).emit("readyUpdate",{ready:r.readyVotes.size,total:r.players.length});
        if(r.players.length>1 && r.readyVotes.size>=r.players.length){
          startNextRound(r.code);
        }
      }
    }
    console.log("Disconnected:",socket.id);
  });
});

const PORT=process.env.PORT||3001;
server.listen(PORT,()=>console.log(`Macung server on port ${PORT}`));
