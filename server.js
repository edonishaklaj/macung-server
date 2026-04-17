const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

// ── ROOMS ──────────────────────────────────────────────────────────────────
const rooms = {}; // roomCode → { players[], gameState, started }

function makeCode(){
  return Math.random().toString(36).substring(2,6).toUpperCase();
}

function getRoomBySocket(socketId){
  return Object.values(rooms).find(r=>r.players.some(p=>p.id===socketId));
}

// ── DECK ───────────────────────────────────────────────────────────────────
const SUITS=["♠","♥","♦","♣"];
const VALUES=["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function createDeck(){
  const d=[];
  for(let copy=0;copy<2;copy++){
    for(const s of SUITS) for(const v of VALUES)
      d.push({id:`${v}${s}_${copy}`,value:v,suit:s,isJoker:false});
    d.push({id:`JK_${copy}`,value:"JK",suit:"",isJoker:true});
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

// ── SOCKET EVENTS ──────────────────────────────────────────────────────────
io.on("connection", (socket)=>{
  console.log("Connected:", socket.id);

  // ── Create room ──
  socket.on("createRoom", ({playerName, tableId}, cb)=>{
    const code = makeCode();
    rooms[code] = {
      code,
      tableId,
      players: [{
        id: socket.id,
        name: playerName,
        seat: 0,
        hand: [],
        isReady: false,
      }],
      deck: [],
      discard: [],
      playerDiscards: [[],[],[],[]],
      current: 0,
      dealer: 0,
      phase: "waiting",
      hasDrawn: false,
      roundNum: 1,
      scores: [0,0,0,0],
      started: false,
    };
    socket.join(code);
    console.log(`Room created: ${code}`);
    cb({ code, seat: 0 });
    io.to(code).emit("roomUpdate", roomInfo(code));
  });

  // ── Join by code ──
  socket.on("joinRoom", ({playerName, code}, cb)=>{
    const room = rooms[code];
    if(!room){ cb({error:"Dhoma nuk ekziston"}); return; }
    if(room.started){ cb({error:"Loja ka filluar"}); return; }
    if(room.players.length>=4){ cb({error:"Dhoma është e plotë"}); return; }

    const takenSeats = room.players.map(p=>p.seat);
    const seat = [0,1,2,3].find(s=>!takenSeats.includes(s));
    room.players.push({id:socket.id, name:playerName, seat, hand:[], isReady:false});
    socket.join(code);
    cb({ code, seat });
    io.to(code).emit("roomUpdate", roomInfo(code));
  });

  // ── Matchmaking — find open room or create ──
  socket.on("findRoom", ({playerName, tableId}, cb)=>{
    const open = Object.values(rooms).find(r=>
      !r.started && r.tableId===tableId && r.players.length<4
    );
    if(open){
      const takenSeats = open.players.map(p=>p.seat);
      const seat = [0,1,2,3].find(s=>!takenSeats.includes(s));
      open.players.push({id:socket.id, name:playerName, seat, hand:[], isReady:false});
      socket.join(open.code);
      cb({code:open.code, seat});
      io.to(open.code).emit("roomUpdate", roomInfo(open.code));
    } else {
      // Create new room
      socket.emit("createRoom", {playerName, tableId});
      socket.once("createRoom", ()=>{});
      const code = makeCode();
      rooms[code]={
        code, tableId,
        players:[{id:socket.id,name:playerName,seat:0,hand:[],isReady:false}],
        deck:[],discard:[],playerDiscards:[[],[],[],[]],
        current:0,dealer:0,phase:"waiting",hasDrawn:false,
        roundNum:1,scores:[0,0,0,0],started:false,
      };
      socket.join(code);
      cb({code, seat:0});
      io.to(code).emit("roomUpdate", roomInfo(code));
    }
  });

  // ── Player ready / Start game ──
  socket.on("startGame", ({code})=>{
    const room = rooms[code];
    if(!room) return;
    const player = room.players.find(p=>p.id===socket.id);
    if(!player || player.seat!==0) return; // only host can start
    if(room.players.length<2){ 
      socket.emit("error","Duhen të paktën 2 lojtarë");
      return;
    }
    dealRound(code);
  });

  // ── Draw from deck ──
  socket.on("drawDeck", ({code})=>{
    const room = rooms[code];
    if(!room||!room.started) return;
    const player = room.players.find(p=>p.id===socket.id);
    if(!player) return;
    if(room.current !== player.seat) return;
    if(room.phase!=="draw"||room.hasDrawn) return;

    if(room.deck.length===0){
      if(room.discard.length<=1) return;
      const top=room.discard.pop();
      room.deck=shuffle(room.discard);
      room.discard=[top];
    }
    const card=room.deck.shift();
    room.players[player.seat].hand.push(card);
    room.hasDrawn=true;
    room.phase="discard";
    io.to(code).emit("gameUpdate", gameState(code));
  });

  // ── Draw from discard ──
  socket.on("drawDiscard", ({code})=>{
    const room = rooms[code];
    if(!room||!room.started) return;
    const player = room.players.find(p=>p.id===socket.id);
    if(!player) return;
    if(room.current !== player.seat) return;
    if(room.phase!=="draw"||room.hasDrawn||room.discard.length===0) return;

    const card=room.discard.pop();
    room.players[player.seat].hand.push(card);
    // Remove from playerDiscards
    room.playerDiscards=room.playerDiscards.map(pile=>pile.filter(c=>c.id!==card.id));
    room.hasDrawn=true;
    room.phase="discard";
    io.to(code).emit("gameUpdate", gameState(code));
  });

  // ── Discard card ──
  socket.on("discardCard", ({code, cardIdx})=>{
    const room = rooms[code];
    if(!room||!room.started) return;
    const player = room.players.find(p=>p.id===socket.id);
    if(!player) return;
    if(room.current !== player.seat) return;
    if(room.phase!=="discard") return;

    const card=room.players[player.seat].hand.splice(cardIdx,1)[0];
    if(!card) return;
    room.discard.push(card);
    room.playerDiscards[player.seat].push(card);
    // Next player
    room.current=(room.current+3)%4;
    // Skip empty seats
    let tries=0;
    while(!room.players.find(p=>p.seat===room.current) && tries<4){
      room.current=(room.current+3)%4;
      tries++;
    }
    room.phase="draw";
    room.hasDrawn=false;
    io.to(code).emit("gameUpdate", gameState(code));
  });

  // ── Finish game (Kent/Macung) ──
  socket.on("finishGame", ({code, type})=>{
    const room = rooms[code];
    if(!room||!room.started) return;
    const player = room.players.find(p=>p.id===socket.id);
    if(!player) return;

    const table = TABLES.find(t=>t.id===room.tableId)||TABLES[0];
    const val = type==="macung" ? table.macung : table.kent;
    const winner = player.seat;

    for(let i=0;i<4;i++){
      if(room.players.find(p=>p.seat===i)){
        if(i===winner) room.scores[i]-=(val*3);
        else room.scores[i]+=val;
      }
    }

    io.to(code).emit("gameFinished",{
      type, winner, val,
      winnerName: player.name,
      winnerHand: room.players[winner].hand,
      scores: room.scores,
    });
  });

  // ── New round ──
  socket.on("newRound", ({code})=>{
    const room = rooms[code];
    if(!room) return;
    room.dealer=(room.dealer+1)%4;
    while(!room.players.find(p=>p.seat===room.dealer)){
      room.dealer=(room.dealer+1)%4;
    }
    room.roundNum++;
    dealRound(code);
  });

  // ── Disconnect ──
  socket.on("disconnect", ()=>{
    const room = getRoomBySocket(socket.id);
    if(!room) return;
    room.players = room.players.filter(p=>p.id!==socket.id);
    if(room.players.length===0){
      delete rooms[room.code];
    } else {
      io.to(room.code).emit("playerLeft", {name: "Lojtari"});
      io.to(room.code).emit("roomUpdate", roomInfo(room.code));
    }
    console.log("Disconnected:", socket.id);
  });
});

// ── HELPERS ────────────────────────────────────────────────────────────────
const TABLES=[
  {id:1,surrender:0.5,kent:1,macung:2},
  {id:2,surrender:1,kent:2,macung:5},
  {id:3,surrender:2,kent:5,macung:10},
  {id:4,surrender:5,kent:10,macung:20},
  {id:5,surrender:10,kent:20,macung:50},
];

function dealRound(code){
  const room = rooms[code];
  room.started = true;
  room.deck = createDeck();
  room.discard = [];
  room.playerDiscards = [[],[],[],[]];
  room.phase = "draw";
  room.hasDrawn = false;

  // Clear hands
  room.players.forEach(p=>{ p.hand=[]; });

  const numPlayers = room.players.length;
  const dealerSeat = room.dealer;

  // Deal cards: dealer gets 15, others get 14
  const sortedSeats = [...room.players].sort((a,b)=>a.seat-b.seat).map(p=>p.seat);
  
  for(const seat of sortedSeats){
    const isDealer = seat===dealerSeat;
    const count = isDealer ? 15 : 14;
    const player = room.players.find(p=>p.seat===seat);
    for(let i=0;i<count;i++){
      player.hand.push(room.deck.shift());
    }
  }

  // Dealer discards one card
  const dealerPlayer = room.players.find(p=>p.seat===dealerSeat);
  const discardCard = dealerPlayer.hand.pop();
  room.discard.push(discardCard);
  room.playerDiscards[dealerSeat].push(discardCard);

  // First player after dealer
  room.current=(dealerSeat+3)%4;
  while(!room.players.find(p=>p.seat===room.current)){
    room.current=(room.current+3)%4;
  }

  io.to(code).emit("gameUpdate", gameState(code));
}

function roomInfo(code){
  const room = rooms[code];
  return {
    code: room.code,
    tableId: room.tableId,
    started: room.started,
    players: room.players.map(p=>({
      seat: p.seat,
      name: p.name,
      cardCount: p.hand.length,
    })),
  };
}

function gameState(code){
  const room = rooms[code];
  // Send each player only their own hand
  const state = {
    code: room.code,
    current: room.current,
    dealer: room.dealer,
    phase: room.phase,
    hasDrawn: room.hasDrawn,
    roundNum: room.roundNum,
    scores: room.scores,
    discard: room.discard,
    playerDiscards: room.playerDiscards,
    deckCount: room.deck.length,
    players: room.players.map(p=>({
      seat: p.seat,
      name: p.name,
      cardCount: p.hand.length,
    })),
    // Private hands sent separately per player
  };

  // Send private hand to each player
  room.players.forEach(p=>{
    io.to(p.id).emit("yourHand", {hand: p.hand});
  });

  return state;
}

// ── START ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, ()=>{
  console.log(`Macung server running on port ${PORT}`);
});
