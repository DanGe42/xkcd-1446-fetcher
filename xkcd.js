var fs = require('fs');
var http = require('http');

var XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
var EventSource = require('eventsource');


var fetchImage = function (imageName, onsuccess, onerror) {
    var url = "http://imgs.xkcd.com/comics/landing/" + imageName;
    var fileErrorHandler = function (err, fd) {
        if (fd) {
            fs.close(fd, function (err) {
                console.warn('Error closing file');
                onerror(err);
            });
        } else {
            onerror(err);
        }
    }

    fs.open('./' + imageName, 'w', function (err, fd) {
        if (err) {
            onerror(err);
            return;
        }

        http.get(url, function (res) {
            if (res.statusCode != 200) {
                fileErrorHandler(new Error('non-200 response'), fd);
                return;
            }

            res.on('data', function (chunk) {
                fs.write(fd, chunk, function (err) {
                    if (err) {
                        fileErrorHandler(err, fd);
                        return;
                    }
                });
            });

            res.on('end', function() {
                fs.close(fd, function (err) {
                    if (err) {
                        fileErrorHandler(err, null);
                    } else {
                        onsuccess(url);
                    }
                });
            });
        }).on('error', function (err) {
            fileErrorHandler(err, fd);
        });
    });
};


(function(global) {
    "use strict";

    function Map() {
        this.data = {}
    }
    Map.prototype = {
        get: function(key) {
            return this.data[key + "~"]
        },
        set: function(key, value) {
            this.data[key + "~"] = value
        },
        "delete": function(key) {
            delete this.data[key + "~"]
        }
    };

    function EventTarget() {
        this.listeners = new Map
    }

    function throwError(e) {
        setTimeout(function() {
            throw e
        }, 0)
    }
    EventTarget.prototype = {
        dispatchEvent: function(event) {
            event.target = this;
            var type = String(event.type);
            var listeners = this.listeners;
            var typeListeners = listeners.get(type);
            if (!typeListeners) {
                return
            }
            var length = typeListeners.length;
            var i = -1;
            var listener = null;
            while (++i < length) {
                listener = typeListeners[i];
                try {
                    listener.call(this, event)
                } catch (e) {
                    throwError(e)
                }
            }
        },
        addEventListener: function(type, callback) {
            type = String(type);
            var listeners = this.listeners;
            var typeListeners = listeners.get(type);
            if (!typeListeners) {
                typeListeners = [];
                listeners.set(type, typeListeners)
            }
            var i = typeListeners.length;
            while (--i >= 0) {
                if (typeListeners[i] === callback) {
                    return
                }
            }
            typeListeners.push(callback)
        },
        removeEventListener: function(type, callback) {
            type = String(type);
            var listeners = this.listeners;
            var typeListeners = listeners.get(type);
            if (!typeListeners) {
                return
            }
            var length = typeListeners.length;
            var filtered = [];
            var i = -1;
            while (++i < length) {
                if (typeListeners[i] !== callback) {
                    filtered.push(typeListeners[i])
                }
            }
            if (filtered.length === 0) {
                listeners["delete"](type)
            } else {
                listeners.set(type, filtered)
            }
        }
    };

    function Event(type) {
        this.type = type;
        this.target = null
    }

    function MessageEvent(type, options) {
        Event.call(this, type);
        this.data = options.data;
        this.lastEventId = options.lastEventId
    }
    MessageEvent.prototype = Event.prototype;
    var XHR = global.XMLHttpRequest;
    var XDR = global.XDomainRequest;
    var isCORSSupported = Boolean(XHR && (new XHR).withCredentials !== undefined);
    var isXHR = isCORSSupported;
    var Transport = isCORSSupported ? XHR : XDR;
    var WAITING = -1;
    var CONNECTING = 0;
    var OPEN = 1;
    var CLOSED = 2;
    var AFTER_CR = 3;
    var FIELD_START = 4;
    var FIELD = 5;
    var VALUE_START = 6;
    var VALUE = 7;
    var contentTypeRegExp = /^text\/event\-stream;?(\s*charset\=utf\-8)?$/i;
    var MINIMUM_DURATION = 1e3;
    var MAXIMUM_DURATION = 18e6;

    function getDuration(value, def) {
        var n = Number(value) || def;
        return n < MINIMUM_DURATION ? MINIMUM_DURATION : n > MAXIMUM_DURATION ? MAXIMUM_DURATION : n
    }

    function fire(that, f, event) {
        try {
            if (typeof f === "function") {
                f.call(that, event)
            }
        } catch (e) {
            throwError(e)
        }
    }

    function EventSource(url, options) {
        url = String(url);
        var withCredentials = Boolean(isCORSSupported && options && options.withCredentials);
        var initialRetry = getDuration(options ? options.retry : NaN, 1e3);
        var heartbeatTimeout = getDuration(options ? options.heartbeatTimeout : NaN, 45e3);
        var lastEventId = options && options.lastEventId && String(options.lastEventId) || "";
        var that = this;
        var retry = initialRetry;
        var wasActivity = false;
        var xhr = new Transport;
        var timeout = 0;
        var timeout0 = 0;
        var charOffset = 0;
        var currentState = WAITING;
        var dataBuffer = [];
        var lastEventIdBuffer = "";
        var eventTypeBuffer = "";
        var onTimeout = null;
        var state = FIELD_START;
        var field = "";
        var value = "";
        options = null;

        function close() {
            currentState = CLOSED;
            if (xhr !== null) {
                xhr.abort();
                xhr = null
            }
            if (timeout !== 0) {
                clearTimeout(timeout);
                timeout = 0
            }
            if (timeout0 !== 0) {
                clearTimeout(timeout0);
                timeout0 = 0
            }
            that.readyState = CLOSED
        }

        function onProgress(isLoadEnd) {
            var responseText = currentState === OPEN || currentState === CONNECTING ? xhr.responseText || "" : "";
            var event = null;
            var isWrongStatusCodeOrContentType = false;
            if (currentState === CONNECTING) {
                var status = 0;
                var statusText = "";
                var contentType = "";
                if (isXHR) {
                    try {
                        status = Number(xhr.status || 0);
                        statusText = String(xhr.statusText || "");
                        contentType = String(xhr.getResponseHeader("Content-Type") || "")
                    } catch (error) {
                        status = 0
                    }
                } else {
                    status = 200;
                    contentType = xhr.contentType
                }
                if (status === 200 && contentTypeRegExp.test(contentType)) {
                    currentState = OPEN;
                    wasActivity = true;
                    retry = initialRetry;
                    that.readyState = OPEN;
                    event = new Event("open");
                    that.dispatchEvent(event);
                    fire(that, that.onopen, event);
                    if (currentState === CLOSED) {
                        return
                    }
                } else {
                    if (status !== 0) {
                        var message = "";
                        if (status !== 200) {
                            message = "EventSource's response has a status " + status + " " + statusText.replace(/\s+/g, " ") + " that is not 200. Aborting the connection."
                        } else {
                            message = "EventSource's response has a Content-Type specifying an unsupported type: " + contentType.replace(/\s+/g, " ") + ". Aborting the connection."
                        }
                        setTimeout(function() {
                            throw new Error(message)
                        });
                        isWrongStatusCodeOrContentType = true
                    }
                }
            }
            if (currentState === OPEN) {
                if (responseText.length > charOffset) {
                    wasActivity = true
                }
                var i = charOffset - 1;
                var length = responseText.length;
                var c = "\n";
                while (++i < length) {
                    c = responseText[i];
                    if (state === AFTER_CR && c === "\n") {
                        state = FIELD_START
                    } else {
                        if (state === AFTER_CR) {
                            state = FIELD_START
                        }
                        if (c === "\r" || c === "\n") {
                            if (field === "data") {
                                dataBuffer.push(value)
                            } else if (field === "id") {
                                lastEventIdBuffer = value
                            } else if (field === "event") {
                                eventTypeBuffer = value
                            } else if (field === "retry") {
                                initialRetry = getDuration(value, initialRetry);
                                retry = initialRetry
                            } else if (field === "heartbeatTimeout") {
                                heartbeatTimeout = getDuration(value, heartbeatTimeout);
                                if (timeout !== 0) {
                                    clearTimeout(timeout);
                                    timeout = setTimeout(onTimeout, heartbeatTimeout)
                                }
                            }
                            value = "";
                            field = "";
                            if (state === FIELD_START) {
                                if (dataBuffer.length !== 0) {
                                    lastEventId = lastEventIdBuffer;
                                    if (eventTypeBuffer === "") {
                                        eventTypeBuffer = "message"
                                    }
                                    event = new MessageEvent(eventTypeBuffer, {
                                        data: dataBuffer.join("\n"),
                                        lastEventId: lastEventIdBuffer
                                    });
                                    that.dispatchEvent(event);
                                    if (eventTypeBuffer === "message") {
                                        fire(that, that.onmessage, event)
                                    }
                                    if (currentState === CLOSED) {
                                        return
                                    }
                                }
                                dataBuffer.length = 0;
                                eventTypeBuffer = ""
                            }
                            state = c === "\r" ? AFTER_CR : FIELD_START
                        } else {
                            if (state === FIELD_START) {
                                state = FIELD
                            }
                            if (state === FIELD) {
                                if (c === ":") {
                                    state = VALUE_START
                                } else {
                                    field += c
                                }
                            } else if (state === VALUE_START) {
                                if (c !== " ") {
                                    value += c
                                }
                                state = VALUE
                            } else if (state === VALUE) {
                                value += c
                            }
                        }
                    }
                }
                charOffset = length
            }
            if ((currentState === OPEN || currentState === CONNECTING) && (isLoadEnd || isWrongStatusCodeOrContentType || charOffset > 1024 * 1024 || timeout === 0 && !wasActivity)) {
                currentState = WAITING;
                xhr.abort();
                if (timeout !== 0) {
                    clearTimeout(timeout);
                    timeout = 0
                }
                if (retry > initialRetry * 16) {
                    retry = initialRetry * 16
                }
                if (retry > MAXIMUM_DURATION) {
                    retry = MAXIMUM_DURATION
                }
                timeout = setTimeout(onTimeout, retry);
                retry = retry * 2 + 1;
                that.readyState = CONNECTING;
                event = new Event("error");
                that.dispatchEvent(event);
                fire(that, that.onerror, event)
            } else {
                if (timeout === 0) {
                    wasActivity = false;
                    timeout = setTimeout(onTimeout, heartbeatTimeout)
                }
            }
        }

        function onProgress2() {
            onProgress(false)
        }

        function onLoadEnd() {
            onProgress(true)
        }
        if (isXHR) {
            timeout0 = setTimeout(function f() {
                if (xhr.readyState === 3) {
                    onProgress2()
                }
                timeout0 = setTimeout(f, 500)
            }, 0)
        }
        onTimeout = function() {
            timeout = 0;
            if (currentState !== WAITING) {
                onProgress(false);
                return
            }
            if (isXHR && (xhr.sendAsBinary !== undefined || xhr.onloadend === undefined) && global.document && global.document.readyState && global.document.readyState !== "complete") {
                timeout = setTimeout(onTimeout, 4);
                return
            }
            xhr.onload = xhr.onerror = onLoadEnd;
            if (isXHR) {
                xhr.onabort = onLoadEnd;
                xhr.onreadystatechange = onProgress2
            }
            xhr.onprogress = onProgress2;
            wasActivity = false;
            timeout = setTimeout(onTimeout, heartbeatTimeout);
            charOffset = 0;
            currentState = CONNECTING;
            dataBuffer.length = 0;
            eventTypeBuffer = "";
            lastEventIdBuffer = lastEventId;
            value = "";
            field = "";
            state = FIELD_START;
            var s = url.slice(0, 5);
            if (s !== "data:" && s !== "blob:") {
                s = url + ((url.indexOf("?", 0) === -1 ? "?" : "&") + "lastEventId=" + encodeURIComponent(lastEventId) + "&r=" + String(Math.random() + 1).slice(2))
            } else {
                s = url
            }
            xhr.open("GET", s, true);
            if (isXHR) {
                xhr.withCredentials = withCredentials;
                xhr.responseType = "text";
                xhr.setRequestHeader("Accept", "text/event-stream")
            }
            xhr.send(null)
        };
        EventTarget.call(this);
        this.close = close;
        this.url = url;
        this.readyState = CONNECTING;
        this.withCredentials = withCredentials;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        onTimeout()
    }

    function F() {
        this.CONNECTING = CONNECTING;
        this.OPEN = OPEN;
        this.CLOSED = CLOSED
    }
    F.prototype = EventTarget.prototype;
    EventSource.prototype = new F;
    F.call(EventSource);
    if (Transport) {
        global.NativeEventSource = global.EventSource;
        global.EventSource = EventSource
    }
})(this);
(function() {
    var SERVERS = ["http://c0.xkcd.com", "http://c1.xkcd.com", "http://c2.xkcd.com", "http://c3.xkcd.com", "http://c4.xkcd.com", "http://c5.xkcd.com", "http://c6.xkcd.com", "http://c7.xkcd.com"];

    function record(name) {
        // (new Image).src = "http://xkcd.com/events/" + name
        console.log("http://xkcd.com/events/" + name);
    }

    function log() {
        console.log.apply(console, arguments)
    }

      var server = SERVERS[Math.floor(Math.random() * SERVERS.length)],
          esURL = server + "/stream/comic/landing?method=EventSource",
          source = new EventSource(esURL);
      log("connecting to event source:", esURL);
      source.addEventListener("open", function(ev) {
          record("connect_start")
      }, false);
      source.addEventListener("error", function(ev) {
          log("connection error", ev);
          record("connect_error")
      }, false);
      source.addEventListener("comic/landing", log, false);
      var firstLoad = true;
      source.addEventListener("comic/landing", function(ev) {
          var data = JSON.parse(ev.data),
              delay = firstLoad ? 0 : Math.round(Math.random() * data.spread);
          log("waiting", delay, "seconds before displaying comic", data.image);
          setTimeout(function() {
              fetchImage(data.image, function(url) {
                  console.info("Fetched " + url);
              }, function(err) {
                  console.error(err);
              });
              firstLoad = false
          }, delay * 1e3)
      }, false);
      source.addEventListener("comic/landing/reload", function(ev) {
          var delay = Math.round(Math.random() * 55);
          log("reloading in", delay + 5, "seconds");
          setTimeout(function() {
              record("reloading");
              setTimeout(function() {
                  location.reload()
              }, 5 * 1e3)
          }, delay * 1e3)
      }, false)
})();
