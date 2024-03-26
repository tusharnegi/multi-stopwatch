import React, { useState, useEffect } from "react";
import './App.css';

function Stopwatch({ title, setTitle, remove }) {
  const [time, setTime] = useState(0);
  const [isActive, setIsActive] = useState(false);
  const [startTime, setStartTime] = useState(0);
  const [elapsedPausedTime, setElapsedPausedTime] = useState(0);

  function toggle() {
    if (!isActive) {
      startTimer();
    } else {
      stopTimer();
    }
  }

  useEffect(() => {
    let interval = null;
    if (isActive) {
      interval = setInterval(() => {
        setTime(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    } else {
      clearInterval(interval);
    }

    return () => clearInterval(interval);
  }, [isActive, startTime]);

  const startTimer = () => {
    setIsActive(true);
    setStartTime(Date.now() - elapsedPausedTime);
  };

  const stopTimer = () => {
    setElapsedPausedTime(new Date().getTime() - startTime); 
    setIsActive(false);
  };

  function reset() {
    setTime(0);
    setElapsedPausedTime(0);
    setIsActive(false);
  }

  // Calculate hours, minutes and seconds  
  // pad the minutes and seconds with leading zeros if needed
  const hours = Math.floor(time / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((time - hours * 3600) / 60).toString().padStart(2, "0");
  const seconds = (time - hours * 3600 - minutes * 60).toString().padStart(2, "0");

  return (
    <div className="stopwatch">
      <div className="time">{`${hours} : ${minutes} : ${seconds}`}</div>
      <button className="toggle" onClick={toggle}>
        {isActive ? "Pause" : "Start"}
      </button>
      <button className="reset" onClick={reset}>
        Reset
      </button>
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      <button className="remove" onClick={remove}>Remove</button>
    </div>
  );
}


function App() {
  const [stopwatches, setStopwatches] = useState(() => {
    // Try to load the state from localStorage  
    const savedState = localStorage.getItem("stopwatches");
    if (savedState) {
      return JSON.parse(savedState);
    } else {
      // This is a default state if nothing is in localStorage  
      return [{ title: "Stopwatch 1", id: 1 }];
    }
  });

  useEffect(() => {
    // Save the state to localStorage whenever it changes  
    localStorage.setItem("stopwatches", JSON.stringify(stopwatches));
  }, [stopwatches]);

  const addStopwatch = () => {
    const id = stopwatches.length + 1;
    setStopwatches([...stopwatches, { title: `Stopwatch ${id}`, id }]);
  };

  const clearAll = () => {
    setStopwatches([{ title: "Stopwatch 1", id: 1 }]);
  };
  const removeStopwatch = (id) => {
    setStopwatches(stopwatches.filter((stopwatch) => stopwatch.id !== id));
  };

  return (
    <div className="app">
      <button className="addStopwatch" onClick={addStopwatch}>Add Stopwatch</button>
      <button className="clearAll" onClick={clearAll}>Clear</button>

      <div className="grid">

        {stopwatches.map((stopwatch, index) => (
          <Stopwatch
            key={index}
            title={stopwatch.title}
            setTitle={(title) => {
              const newStopwatches = [...stopwatches];
              newStopwatches[index].title = title;
              setStopwatches(newStopwatches);
            }}
            remove={() => removeStopwatch(stopwatch.id)}
          />
        ))}
      </div>
    </div>
  );
}

export default App;  
