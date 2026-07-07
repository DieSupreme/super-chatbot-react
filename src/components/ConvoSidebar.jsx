import React, { useState, useRef, useEffect } from 'react';
import { fmtCost } from '../models.js';

function ConvoItem({ c, active, onOpen, onRename, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.title || 'Untitled');
  const inpRef = useRef(null);
  const doneRef = useRef(false);   // guards double-commit (Enter fires blur too)

  useEffect(() => {
    if (editing && inpRef.current) { inpRef.current.focus(); inpRef.current.select(); }
  }, [editing]);

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
    onRename(c.id, name.trim() || c.title || 'Untitled');
  };
  const startEdit = (e) => {
    e.stopPropagation();
    doneRef.current = false;
    setName(c.title || 'Untitled');
    setEditing(true);
  };

  const when = new Date(c.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className={'convo-item' + (active ? ' active' : '')} onClick={() => !editing && onOpen(c.id)}>
      <div className="ct">
        {editing ? (
          <input className="rename" value={name}
            ref={inpRef}
            onChange={e => setName(e.target.value)}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') { doneRef.current = true; setEditing(false); }
            }}
            onBlur={commit} />
        ) : (
          <>
            <div className="nm">{c.title || 'Untitled'}</div>
            <div className="mt">{fmtCost(c.cost)} · {when}</div>
          </>
        )}
      </div>
      <span className="ren" title="Rename" onClick={startEdit}>✎</span>
      <span className="del" title="Delete" onClick={e => { e.stopPropagation(); onDelete(c.id); }}>🗑</span>
    </div>
  );
}

export default function ConvoSidebar({ convos, currentId, onNew, onOpen, onRename, onDelete, searchRef }) {
  const [filter, setFilter] = useState('');
  const list = filter
    ? convos.filter(c => (c.title || '').toLowerCase().includes(filter.toLowerCase()))
    : convos;

  return (
    <aside id="convoBar">
      <button id="newChat" onClick={onNew}>＋ New chat</button>
      <input id="convoSearch" ref={searchRef} placeholder="Search chats…" autoComplete="off"
        value={filter} onChange={e => setFilter(e.target.value)} />
      <div id="convoList">
        {!list.length ? (
          <div className="convo-empty">{filter ? 'No chats match.' : 'No saved chats yet.'}</div>
        ) : list.map(c => (
          <ConvoItem key={c.id} c={c} active={c.id === currentId}
            onOpen={onOpen} onRename={onRename} onDelete={onDelete} />
        ))}
      </div>
    </aside>
  );
}
