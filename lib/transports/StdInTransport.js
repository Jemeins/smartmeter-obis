function StdInTransport(options, protocol) {
    this.options = options;
    this.protocol = protocol;
    this.stdInStream = undefined;

    this.requestTimer = null;
    this.stopRequests = false;
    this.currentData = null;
    this.currentDataOffset = 0;
    this.messageTimeoutTimer = null;

    if (!this.options.transportStdInMaxBufferSize) this.options.transportStdInMaxBufferSize = 300000;
    if (!this.options.transportStdInMessageTimeout) this.options.transportStdInMessageTimeout = 120000;

    var self = this;
    this.protocol.setTransportResetCallback(function(res) {
        if (self.options.debug === 2) self.options.logger('Transport Reset!! Restart = ' + !self.stopRequests);
        if (!self.stopRequests) {
            self.stop(function() {
                self.stopRequests = false;
                self.scheduleNextRun();
            });
        }
    });
}

StdInTransport.prototype.init = function init() {
    this.protocol.initState(); // init State from protocol instance

    if (!this.stdInStream) {
        this.stdInStream = process.stdin;
        if (this.options.debug === 2) this.options.logger('ASSIGN STDIN');
    }
    var self = this;
    this.stdInStream.on('data', function (data) {
        if (!data || !Buffer.isBuffer(data)) return;

        if (! self.currentData) {
            if (Buffer.alloc) { // Node 6+
                self.currentData = Buffer.alloc(self.options.transportStdInMaxBufferSize, 0);
            }
            else {
                self.currentData = new Buffer(self.options.transportStdInMaxBufferSize).fill(0);
            }
        }
        if (data.length > 0) {
            data.copy(self.currentData, self.currentDataOffset);
            self.currentDataOffset += data.length;
        }
        if (self.protocol.checkMessage(self.currentData.slice(0, self.currentDataOffset))) {
            if (self.messageTimeoutTimer) {
                clearTimeout(self.messageTimeoutTimer);
                self.messageTimeoutTimer = null;
            }

            if (self.options.debug === 2) self.options.logger('PAUSE READING STDIN TO HANDLE MESSAGE');
            self.stdInStream.pause();
            var addData = self.protocol.handleMessage(self.currentData.slice(0, self.currentDataOffset));
            if (Buffer.alloc) { // Node 6+
                self.currentData = Buffer.alloc(self.options.transportStdInMaxBufferSize, 0);
            }
            else {
                self.currentData = new Buffer(self.options.transportStdInMaxBufferSize).fill(0);
            }
            self.currentDataOffset = 0;
            if (addData && addData.length > 0) {
                addData.copy(self.currentData, 0);
                self.currentDataOffset = addData.length;
            }
            if (!self.protocol.isProcessComplete()) {
                if (self.protocol.messagesToSend() > 0 && self.options.debug === 2) {
                    self.options.logger('StdInTransport do not support sending of Data! Ignore them');
                }
            }
            if (self.options.debug === 2) self.options.logger('SET MESSAGE TIMEOUT TIMER: ' + self.options.transportStdInMessageTimeout);
            if (self.messageTimeoutTimer) {
                clearTimeout(self.messageTimeoutTimer);
                self.messageTimeoutTimer = null;
            }
            self.messageTimeoutTimer = setTimeout(function() {
                self.messageTimeoutTimer = null;
                self.handleStdInTimeout();
            }, self.options.transportStdInMessageTimeout);
            if (self.options.debug === 2) self.options.logger('RESUME READING STDIN');
            if (self.stdInStream && !self.stopRequests) self.stdInStream.resume(); // we want to read continously

            if (self.protocol.isProcessComplete()) {
                if (self.options.requestInterval!==0) {
                    if (self.messageTimeoutTimer) {
                        clearTimeout(self.messageTimeoutTimer);
                        self.messageTimeoutTimer = null;
                    }
                    this.pause();
                    if (! self.stopRequests) {
                        if (self.options.debug === 2) self.options.logger('SCHEDULE NEXT RUN IN ' + self.options.requestInterval + 's');
                        self.scheduleNextRun();
                    }
                }
            }
            if (self.options.debug === 2 && self.currentData) self.options.logger('REMAINING DATA AFTER MESSAGE HANDLING: ' + self.currentData.slice(0, self.currentDataOffset).toString());
        }
        else if (self.currentDataOffset === self.options.transportStdInMaxBufferSize) {
            self.protocol.callUserCallback(new Error('Maximal Buffer size reached without matching message : ' + self.currentData.toString()), null);
        }
    });

    this.stdInStream.on('error', function (msg) {
        if (self.options.debug !== 0) self.options.logger('STDIN ERROR: ' + msg);
        self.currentData = null;
        self.currentDataOffset = 0;
    });

    this.stdInStream.on('end', function () {
        if (self.options.debug !== 0) self.options.logger('STDIN END');
        self.stop();
    });

    this.currentData = null;
    this.currentDataOffset = 0;
};

StdInTransport.prototype.scheduleNextRun = function scheduleNextRun() {
    if (!this.stopRequests) {
        if (this.requestTimer) {
            clearTimeout(this.requestTimer);
            this.requestTimer = null;
        }
        self = this;
        this.requestTimer = setTimeout(function() {
            self.requestTimer = null;
            if (!self.stdInStream) self.init();
                else self.protocol.initState(); // reset Protocol instance because it will be a new session
            self.process(); // and open port again
        }, this.options.requestInterval*1000);
    }
};


StdInTransport.prototype.process = function process() {
    this.currentData = null;
    this.currentDataOffset = 0;
    var self = this;
    if (self.options.debug === 2) self.options.logger('STDIN RESUME');
    self.currentData = null;
    self.currentDataOffset = 0;

    self.stdInStream.resume();
    if (self.messageTimeoutTimer) {
        clearTimeout(self.messageTimeoutTimer);
        self.messageTimeoutTimer = null;
    }
    if (self.options.debug === 2) self.options.logger('SET MESSAGE TIMEOUT TIMER: ' + self.options.transportStdInMessageTimeout);
    self.messageTimeoutTimer = setTimeout(function() {
        self.messageTimeoutTimer = null;
        self.handleStdInTimeout();
    }, self.options.transportStdInMessageTimeout);
};

StdInTransport.prototype.stop = function stop(callback) {
    this.stopRequests = true;
    if (this.requestTimer) {
        clearTimeout(this.requestTimer);
        this.requestTimer = null;
    }
    if (this.messageTimeoutTimer) {
        clearTimeout(this.messageTimeoutTimer);
        this.messageTimeoutTimer = null;
    }
    var self = this;
    if (self.stdInStream) {
        self.stdInStream.pause();
        self.currentData = null;
        self.currentDataOffset = 0;
        if (this.stopRequests) {
            self.stdInStream.removeAllListeners();
        }

    }
    if (callback) callback();
};

StdInTransport.prototype.handleStdInTimeout = function handleStdInTimeout() {
    if (this.options.debug === 2) this.options.logger('MESSAGE TIMEOUT TRIGGERED');
    this.protocol.callUserCallback(new Error('No or too long answer from StdIn after last request.'), null);
};

module.exports = StdInTransport;