var io;
var gameSocket;
var db;

const fetch = require('node-fetch');
const async = require('async');

/**
 * This function is called by index.js to initialize a new game instance.
 *
 * @param sio The Socket.IO library
 * @param socket The socket object for the connected client.
 */
exports.initGame = function(sio, socket,sdb){
    io = sio;
    gameSocket = socket;
    db=sdb;
    gameSocket.emit('connected', { message: "You are connected!" });

    //common event
    gameSocket.on('findLeader',findLeader);

    // Host Events
    gameSocket.on('hostCreateNewGame', hostCreateNewGame);
    gameSocket.on('hostRoomFull', hostPrepareGame);
    gameSocket.on('hostCountdownFinished', hostStartGame);
    gameSocket.on('hostNextRound', hostNextRound);

    // Player Events
    gameSocket.on('playerJoinGame', playerJoinGame);
    gameSocket.on('playerAnswer', playerAnswer);
    gameSocket.on('playerRestart', playerRestart);
}

/* *******************************
   *                             *
   *       HOST FUNCTIONS        *
   *                             *
   ******************************* */

/**
 * The 'START' button was clicked and 'hostCreateNewGame' event occurred.
 */
function hostCreateNewGame() {
    // Create a unique Socket.IO Room
    var thisGameId = ( Math.random() * 100000 ) | 0;

    // Return the Room ID (gameId) and the socket ID (mySocketId) to the browser client
    this.emit('newGameCreated', {gameId: thisGameId, mySocketId: this.id});

    // Join the Room and wait for the players
    this.join(thisGameId.toString());
};

/*
 * Two players have joined. Alert the host!
 * @param gameId The game ID / room ID
 */
function hostPrepareGame(gameId) {
    var sock = this;
    var data = {
        mySocketId : sock.id,
        gameId : gameId
    };
    //console.log("All Players Present. Preparing game...");
    io.sockets.in(data.gameId).emit('beginNewGame', data);
}

/*
 * The Countdown has finished, and the game begins!
 * @param gameId The game ID / room ID
 */
function hostStartGame(gameId) {
    console.log('Game Started.');
    sendQuestion(0,gameId);
};

/**
 * A player answered correctly. Time for the next question.
 * @param data Sent from the client. Contains the current round and gameId (room)
 */
function hostNextRound(data) {
    if(data.round < questionPool.length ){
        // Send a new set of questions back to the host and players.
        sendQuestion(data.round, data.gameId);
    } else {

      if(!data.done)
      {
        //updating players win count
        db.all("SELECT * FROM player WHERE player_name=?",data.winner, function(err, rows) {
        rows.forEach(function (row) {
            win=row.player_win;
            win++;
            console.log(win);
            db.run("UPDATE player SET player_win = ? WHERE player_name = ?", win, data.winner);
            console.log(row.player_name, row.player_win);
        })
        });
        data.done++;
      }
        // If the current round exceeds the number of questions, send the 'gameOver' event.
      io.sockets.in(data.gameId).emit('gameOver',data);
    }
}

// function for finding leader
function findLeader()
{
  console.log("finding leader");
    var sock=this;
    var i=0;
    leader={};
    db.all("SELECT * FROM player ORDER BY player_win DESC LIMIT 10",function(err,rows)
    {
      if(rows!=undefined)
      {
        rows.forEach(function (row)
        {
          leader[i]={};
          leader[i]['name']=row.player_name;
          leader[i]['win']=row.player_win;
          console.log(row.player_name);
          console.log(row.player_win);
          i++;
        })
      }
      console.log("found leader");
      sock.emit('showLeader',leader);
    });

}
/* *****************************
   *                           *
   *     PLAYER FUNCTIONS      *
   *                           *
   ***************************** */

/**
 * A player clicked the 'START GAME' button.
 * Attempt to connect them to the room that matches
 * the gameId entered by the player.
 * @param data Contains data entered via player's input - playerName and gameId.
 */
function playerJoinGame(data) {
    //console.log('Player ' + data.playerName + 'attempting to join game: ' + data.gameId );

    // A reference to the player's Socket.IO socket object
    var sock = this;

    // Look up the room ID in the Socket.IO manager object.
    var room = gameSocket.manager.rooms["/" + data.gameId];

    // If the room exists...
    if( room != undefined ){
        // attach the socket id to the data object.
        data.mySocketId = sock.id;

        // Join the room
        sock.join(data.gameId);
        db.serialize(function()
            {
                var stmt = " SELECT * FROM player WHERE player_name='"+data.playerName+"';";
                db.get(stmt, function(err, row){
                    if(err) throw err;
                    if(typeof row == "undefined") {
                            db.prepare("INSERT INTO player (player_name,player_win) VALUES(?,?)").run(data.playerName,0).finalize();
                    } else {
                        console.log("row is: ", row);
                    }
                });
            });
        //console.log('Player ' + data.playerName + ' joining game: ' + data.gameId );

        // Emit an event notifying the clients that the player has joined the room.
        io.sockets.in(data.gameId).emit('playerJoinedRoom', data);

    } else {
        // Otherwise, send an error message back to the player.
        this.emit('error',{message: "This room does not exist."} );
    }
}

/**
 * A player has tapped a question in the question list.
 * @param data gameId
 */
function playerAnswer(data) {
    // console.log('Player ID: ' + data.playerId + ' answered a question with: ' + data.answer);

    // The player's answer is attached to the data object.  \
    // Emit an event with the answer so it can be checked by the 'Host'
    io.sockets.in(data.gameId).emit('hostCheckAnswer', data);
}

/**
 * The game is over, and a player has clicked a button to restart the game.
 * @param data
 */
function playerRestart(data) {
    console.log('Player: ' + data.playerName + ' ready for new game.');

    // Emit the player's data back to the clients in the game room.
    data.playerId = this.id;
    io.sockets.in(data.gameId).emit('playerJoinedRoom',data);
}

/* *************************
   *                       *
   *      GAME LOGIC       *
   *                       *
   ************************* */

/**
 * Get a question for the host, and a list of questions for the player.
 *
 * @param questionPoolIndex
 * @param gameId The room identifier
 */
function sendQuestion(questionPoolIndex, gameId) {
    var data = getQuestionData(questionPoolIndex);
    io.sockets.in(data.gameId).emit('newQuestionData', data);
}

/**
 * This function does all the work of getting a new questions from the pile
 * and organizing the data to be sent back to the clients.
 *
 * @param i The index of the questionPool.
 * @returns {{round: *, question: *, answer: *, list: Array}}
 */
function getQuestionData(i){
    // Randomize the order of the available questions.
    // The first element in the randomized array will be displayed on the host screen.
    // The second element will be hidden in a list of decoys as the correct answer
    var questions = shuffle(questionPool[i].question);
    console.log('question:', questions);

    // Get the answer.
    var answer = questionPool[i].answer;
    console.log('answer:', answer);

    // Randomize the order of the decoy questions and choose the first 3
    var decoys = shuffle(questionPool[i].decoys).slice(0,3);
    console.log('decoys:', decoys)

    // Pick a random spot in the decoy list to put the correct answer
    var rnd = Math.floor(Math.random() * 3);
    decoys.splice(rnd, 0, answer);

    // Package the questions into a single object.
    var questionData = {
        round: i,
        question : questions[0],   // Displayed question
        answer : answer, // Correct Answer
        list : decoys      // question list for player (decoys and answer)
    };

    return questionData;
}

/*
 * Javascript implementation of Fisher-Yates shuffle algorithm
 * http://stackoverflow.com/questions/2450954/how-to-randomize-a-javascript-array
 */
function shuffle(array) {
    var currentIndex = array.length;
    var temporaryValue;
    var randomIndex;

    // While there remain elements to shuffle...
    while (0 !== currentIndex) {

        // Pick a remaining element...
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex -= 1;

        // And swap it with the current element.
        temporaryValue = array[currentIndex];
        array[currentIndex] = array[randomIndex];
        array[randomIndex] = temporaryValue;
    }

    return array;
}

/**
 * Each element in the array provides data for a single round in the game.
 *
 * In each round, two random "questions" are chosen as the host question and the correct answer.
 * Five random "decoys" are chosen to make up the list displayed to the player.
 * The correct answer is randomly inserted into the list of chosen decoys.
 * This data need to eventually come from http://dev-mcgame.pantheonsite.io/game_data?category=Cartoons
 *
 * @type {Array}
 */
var questionPool = [
    {
        "question": [ "Pocahontas was supposed to have a talking pet what?" ],
        "answer" : ["Turkey"],
        "decoys" : [ "Squirrel", "Wolf", "Mockingbird", "Turtle" ]
    },

    {
        "question": [ "Who refused to play the part of the vultures in The Jungle Book?" ],
        "answer" : ["The Beatles"],
        "decoys" : [ "The Rolling Stones", "The Grateful Dead", "Aerosmith", "Tom Petty and the Heartbreakers" ]
    },

    {
        "question": [ "Which two characters used the same voice actor?" ],
        "answer": ["Eeyore and Optimus Prime"],
        "decoys" : [ "Bugs Bunny and Daffy Duck", "Minnie Mouse and Elsa", "Aladdin and Flynn Rider" ]
    },

    {
        "question"  : [ "The Lady and the Tramp was almost called:" ],
        "answer": ["All of these Answers"],
        "decoys" : [ "The Lady and the Bozo", "The Lady and the Homer", "The Lady and the Rags" ]
    },

    {
        "question"  : [ "How old is Ariel when she marries Eric in The Little Mermaid?" ],
        "answer": ["16"],
        "decoys" : [ "21","19","13","25" ]
    }

]
