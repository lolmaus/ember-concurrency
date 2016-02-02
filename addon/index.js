import Ember from 'ember';
import getOwner from 'ember-getowner-polyfill';
import Task from 'ember-concurrency/task';
import AsyncIterator from 'ember-concurrency/async-iterator';

let testGenFn = function * () {};
let testIter = testGenFn();
Ember.assert(`ember-concurrency requires that you set babel.includePolyfill to true in your ember-cli-build.js (or Brocfile.js) to ensure that the generator function* syntax is properly transpiled, e.g.:

  var app = new EmberApp({
    babel: {
      includePolyfill: true,
    }
  });`,
  (typeof testIter.next      === 'function' &&
   typeof testIter['return'] === 'function' &&
   typeof testIter['throw']  === 'function'));

export function DidNotRunException() {
  this.success = false;
  this.reason = "unperformable";
}

const NEXT   = 'next';
const THROW  = 'throw';
const RETURN = 'return';

const DISCONTINUE_TRAMPOLINE = {};
const DISCONTINUE_ONLY_THIS_TRAMPOLINE = {};

export let csp = window.csp;

csp.set_queue_delayer(function(f, delay) {
  Ember.run.later(f, delay);
});

csp.set_queue_dispatcher(function(f) {
	Ember.run.join(this, function() {
		Ember.run.schedule('actions', f);
	});
});

let EventedObservable = Ember.Object.extend({
  obj: null,
  eventName: null,

  subscribe(onNext) {
    let obj = this.obj;
    let eventName = this.eventName;
    obj.on(eventName, onNext);

    let isDisposed = false;
    return {
      dispose: () => {
        if (isDisposed) { return; }
        isDisposed = true;
        obj.off(eventName, onNext);
      }
    };
  },
});

Ember.Evented.reopen({
  on() {
    if (arguments.length === 1) {
      return EventedObservable.create({ obj: this, eventName: arguments[0] });
    } else {
      return this._super.apply(this, arguments);
    }
  },
});

export let Process = Ember.Object.extend({
  owner: null,
  generatorFunction: null,

  _currentProcess: null,

  isRunning: false,

  start(args, completionHandler) {
    if (this._currentProcess) {
      // already running; use restart() to restart.
      // NOTE: what if arguments have changed?
      // it seems like we want something that says "make sure
      // this process is running, with these args, but don't
      // restart unless the args have changed". Lowest level of
      // allowing this would be saving the current args in an externally
      // inspectable way.
      return;
    }

    this.set('isRunning', true);

    let owner = this.owner;
    let iter = this.generatorFunction.apply(owner, args);
    this._currentProcess = csp.spawn(iter);
    this._currentProcess.process._emberProcess = this;

    csp.takeAsync(this._currentProcess, returnValue => {
      if (completionHandler) {
        completionHandler(returnValue);
      }
      this.kill();
    });
  },

  stop() {
    this.kill();
  },

  kill() {
    if (this._currentProcess) {
      this.set('isRunning', false);
      let processChannel = this._currentProcess;
      processChannel.close();
      processChannel.process.close();
      this._currentProcess = null;
    }
  },

  restart(...args) {
    this.kill();
    this.start(args);
  },
});

function cleanupOnDestroy(owner, object, cleanupMethodName) {
  // TODO: find a non-mutate-y, hacky way of doing this.
  if (!owner.willDestroy.__ember_processes_destroyers__) {
    let oldWillDestroy = owner.willDestroy;
    let disposers = [];

    owner.willDestroy = function() {
      for (let i = 0, l = disposers.length; i < l; i ++) {
        disposers[i]();
      }
      oldWillDestroy.apply(owner, arguments);
    };
    owner.willDestroy.__ember_processes_destroyers__ = disposers;
  }

  owner.willDestroy.__ember_processes_destroyers__.push(() => {
    object[cleanupMethodName]();
  });
}

function liveComputed(...args) {
  let cp = Ember.computed(...args);
  cp.setup = function(obj, keyname) {
    Ember.addListener(obj, 'init', null, function() {
      this.get(keyname);
    });
  };
  return cp;
}

export function sleep(ms) {
  if (arguments.length === 0) {
    // return anonymous channel that never closes;
    // useful for processes since every yield is combined
    // with an implicit close channel.
    return csp.chan();
  } else {
    return csp.timeout(ms);
  }
}

sleep.untilEvent = function(obj, eventName) {
  let chan = csp.chan();
  Ember.addListener(obj, eventName, null, event => {
    csp.putAsync(chan, event);
    // need to close chan? does it matter if it's anonymous?
  }, true);
  return chan;
};

let chan = csp.chan();
let RawChannel = chan.constructor;
chan.close();

RawChannel.prototype.hasTakers = false;

let oldTake = RawChannel.prototype._take;
let oldPut = RawChannel.prototype._put;

RawChannel.prototype._take = function() {
  let ret = oldTake.apply(this, arguments);
  this.refreshBlockingState();
  return ret;
};

RawChannel.prototype._put= function() {
  let ret = oldPut.apply(this, arguments);
  this.refreshBlockingState();
  return ret;
};

RawChannel.prototype.refreshBlockingState = function () {
  Ember.set(this, 'hasTakers', this.takes.length > 0);
};

export function channel(...args) {
  let bufferConstructor = args[0];
  return liveComputed(function() {
    let chan;
    if (typeof bufferConstructor === 'function') {
      chan = csp.chan(bufferConstructor(args[1]));
    } else if (args.length === 1) {
      chan = csp.chan(args[0]);
    } else {
      chan = csp.chan();
    }
    cleanupOnDestroy(this, chan, 'close');
    return chan;
  });
}

export function makePublisher(pubConstructor) {
  // 20 is arbitrary, but probably an OK default?
  // The reason we need it is that if you have
  // pending putAsyncs and you close the channel,
  // the close cancels those putAsyncs, which is
  // probably undesirable for the pattern where a
  // producer generates a bunch of values and closes.
  //
  // See here: https://github.com/ubolonton/js-csp/issues/63
  //
  // TODO: we should probably devise a better system
  // for integrating with Observables that are backpressure
  // aware
  let chan = csp.chan(20);

  let disposer = Ember.K;

  let hasClosed = false;
  let oldClose = chan.close;
  chan.close = () => {
    if (hasClosed) { return; }
    hasClosed = true;
    oldClose.call(chan);
    disposer();
  };

  let publishHandle = (v) => {
    if (hasClosed) {
      return;
    }
    csp.putAsync(chan, v);
  };
  publishHandle.close = () => {
    chan.close();
  };

  let maybeDisposer = pubConstructor(publishHandle);
  if (typeof maybeDisposer === 'function') {
    disposer = maybeDisposer;
  }

  return chan;
}

export function task(...args) {
  let _genFn;
  if (typeof args[args.length - 1] === 'function') {
    _genFn = args.pop();
  }

  let autoStart = false;

  let desc = liveComputed(function(key) {
    let _dispatcher = getOwner(this).lookup('service:ember-concurrency-dispatcher');
    Ember.assert(`You can only use task() on Ember Objects instantiated from a container`, _dispatcher);

    Ember.assert(`Task '${key}' specifies more than one dependent task, which is not presently supported`, args.length <= 1);

    let _depTasks = args.map(path => {
      let depTask = this.get(path);
      if (depTask instanceof Task) {
        return depTask;
      } else {
        // TODO: log this? better API than quietly failing?
        return null;
      }
    });

    let _depTask = _depTasks[0];

    if (!_genFn) {
      _genFn = function * (...args) {
        if (_depTask) {
          let value = yield _depTask.perform(...args);
          return value;
        }
      };
    }

    let task = Task.create({
      _dispatcher,
      _hostObject: this,
      _genFn,
      _depTask,
    });

    cleanupOnDestroy(this, task, 'destroy');

    if (autoStart) {
      task.perform();
    }

    return task;
  });

  desc.autoStart = () => {
    autoStart = true;
    return desc;
  };

  return desc;
}

export function asyncIterator(obs) {
  return AsyncIterator.create({
    _observable: obs,
  });
}

asyncIterator.fromEvent = function(obj, eventName) {
  return AsyncIterator.create({
    _observable: EventedObservable.create({ obj, eventName })
  });
};

export function asyncLoop(iterable, genFn) {
  let task = Ember.get(csp.Process, '_current._emberProcess._task');

  if (!task) {
    throw new Error("Tried to invoke asyncLoop outside of task");
  }

  return csp.go(crankAsyncLoop, [iterable, task._hostObject, genFn]);
}

function * crankAsyncLoop(iterable, hostObject, genFn) {
  let ai = AsyncIterator.create({
    _observable: iterable,
  });

  let didBreak = false;
  while (true) {
    if (didBreak) {
      break;
    }

    let { value, done } = yield ai.next();
    if (done) { break; }

    let spawnChannel;
    let controlObj = {
      break() {
        let process = spawnChannel.process;
        process.close();
        ai.dispose();
        didBreak = true;
        return new csp.Instruction("close");
      },
    };

    spawnChannel = csp.spawn(genFn.call(hostObject, value, controlObj));
    yield spawnChannel;
  }
}

export function forEach(iterable, fn) {
  let owner;
  Ember.run.schedule('actions', () => {
    if (!owner) {
      throw new Error("You must call forEach(...).attach(this) if you're using forEach outside of a generator function");
    }
  });

  return {
    attach(_owner) {
      owner = _owner;
      let it = start(iterable, fn);
      cleanupOnDestroy(owner, it, 'dispose');
    },
  };
}

function start(iterable, fn) {
  let rawIterable = iterable[Symbol.iterator]();
  let it = makeSourceIterator(rawIterable);
  it.fn = fn;
  it.dispose = function () {
    if (this.isDisposed) { return; }
    this.isDisposed = true;

    // kill the inner loop / disposables
    debugger;
  };

  trampoline(stepThroughSource, null, it, NEXT);
  return it;
}

function trampoline(steppingFn, _nextValue, it, method) {
  let nextValue = _nextValue;
  while (true) {
    let value = steppingFn(nextValue, it, method);
    if (value === DISCONTINUE_TRAMPOLINE) {
      return DISCONTINUE_TRAMPOLINE;
    } else if (value === DISCONTINUE_ONLY_THIS_TRAMPOLINE) {
      return;
    } else {
      nextValue = value;
    }
  }
}

function isAsyncProducer(v) {
  return v && (
    typeof v.then === 'function' ||
    typeof v.subscribe === 'function'
  );
}

function isIterator(v) {
  // Symbol polyfill?
  return v && typeof v.next === 'function';
}

function stepThroughSource(nextValue, it, method) {
  // Get the next value from the source iterable, e.g. `1` from [1,2,3]
  let { value, done } = it.proceed(method, nextValue);
  if (done) {
    // what to do here?
    return;
  }

  // Pass it to the mapping fn, which maybe be a normal fn or a generator fn
  let mValue = it.fn(value);


  // forEach([1,2,3], v => {
  //   if (v >= 2) {
  //     Break();
  //     // BREAK
  //
  //     how would this work? well, you'd have
  //
  //     FUCK THIS ASYNC EVERYTHING
  //   }
  // });



  // Normalize the value into an iterable:
  // (v) => return Promise
  //   becomes an iterable that returns a promise and finishes
  // (v) => return Observable
  //   becomes an iterable that returns an observable and finishes
  // function * () {...}
  //   already is an iterable, so does nothing
  let subit = makeIterator(mValue, it);


  // loop over this iterable with trampolining to avoid creating deep
  // stacks when looping over a large synchronous iterable, like an array
  //trampoline(substep, null, subit, NEXT);

  // the result of this governs what to tell parent trampoline.
  // if it's just a bunch of synchronous yields then we should
  // let the parent trampoline keep going. If it's async in
  // any way, then we stop.
  return trampoline(substep, null, subit, NEXT);
}

function substep(nextValue, it, method) {
  let { value, done } = it.proceed(method, nextValue);

  if (done) {
    return DISCONTINUE_ONLY_THIS_TRAMPOLINE;
  }

  let proceed, disposable;
  if (value && typeof value.then === 'function') {
    proceed = it.getProceed();
    value.then(v => {
      proceed([NEXT, v]);
    }, error => {
      proceed([THROW, error]);
    });
    return DISCONTINUE_TRAMPOLINE;
  } else if (value && typeof value.subscribe === 'function') {
    proceed = it.getProceed();
    disposable = value.subscribe(v => {
      proceed([NEXT, v]);
    }, error => {
      proceed([THROW, error]);
    }, () => {
      proceed([NEXT, null]); // replace with "no value" token?
    });
    it.registerDisposable(disposable);
    return DISCONTINUE_TRAMPOLINE;
  } else {
    return value;
  }
}

function makeSourceIterator(value) {
  let it;
  if (value && typeof value.next === 'function') {
    it = value;
  } else {
    let done = false;
    it = {
      next() {
        if (done) {
          return {
            done: true,
            value: undefined,
          };
        } else {
          done = true;
          return {
            done: false,
            value,
          };
        }
      }
    };
    it.source = value;
  }
  return it;
}

function makeIterator(value, parentIt) {
  let it = makeSourceIterator(value);

  let disposables = [];
  let defer;
  let subit = {
    getProceed() {
      if (!defer) {
        defer = Ember.RSVP.defer();
        defer.promise.then(([method, value]) => {
          trampoline(substep, value, this, method);
        });
      }
      return defer.resolve;
    },
    registerDisposable(d) {
      disposables.push(d);
    },
    proceed(method, value) {
      disposeAll(disposables);
      return this[method](value);
    },
    dispose() {
      disposeAll(disposables);
      this.proceed(RETURN);
    },
    next(value) {
      return it.next(value);
    },
    throw(error) {
      if (typeof it.throw === 'function') {
        return it.throw(error);
      } else {
        throw error;
      }
    },
    return(v) {
      if (typeof it.return === 'function') {
        return it.return(v);
      } else {
        return {
          done: true,
          value: v,
        };
      }
    },
  };

  if (parentIt) {
    parentIt.registerDisposable(() => {
      subit.proceed(RETURN); // or throw?
    });
  }

  return subit;
}

function disposeAll(disposables) {
  for (let i = 0; i < disposables.length; ++i) {
    disposables[i]();
  }
  disposables.length = 0;
}

