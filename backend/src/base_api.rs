//! The Base screen's API: build a base, set up three waves, practise against
//! your own base, scout and raid someone else's, and replay logged raids.
//!
//!   GET  /api/base?token=            the active operator's base
//!   POST /api/base/save              {layout?, waves?}             buy and save
//!   POST /api/base/practice          {layout?, waves, entrances}   a raid on yourself; changes nothing
//!   POST /api/base/scout             find a base to raid
//!   POST /api/base/raid              {entrances}                   raid the scouted base
//!   POST /api/base/replay            {id}                          replay a logged raid
//!   POST /api/base/refill            restore and buy back lost wave troops
//!   POST /api/base/sell              {kind, count?}                sell spare owned pieces/troops (50%)
//!   POST /api/base/ack               mark defense raid notifications read
//!
//! Every reply carries the base as it now stands.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde_json::{json, Value};

use crate::db::{self, Database};
use crate::siege::{self, Counts, Layout, Plan, WAVES};
use crate::{auth, pvp_enabled, request_user, AppState};

/// The base as the client shows it, with the rules it needs to draw the shop.
fn base_json(db: &Database, profile: &str) -> Value {
    let now = db::now_secs();
    let Some(state) = db.base_state(profile, now) else { return Value::Null };
    let blocker = if !pvp_enabled() {
        Some("Base raids are switched off on this server. You can still build and practise.".to_string())
    } else if !state.raidable {
        Some(format!("{} is a Safe operator: its base can't be raided and it can't raid others. Build and practise freely.", state.name))
    } else { None };
    let mut out = serde_json::to_value(&state).unwrap_or_default();
    out["rules"] = siege::catalog_json(state.tier);
    out["now"] = now.into();
    out["raidBlocker"] = blocker.into();
    // A scouted base means nothing while raids are off.
    if !pvp_enabled() { out["target"] = Value::Null; out["atRisk"] = 0.into(); }
    out
}

fn reply(db: &Database, profile: &str, result: Result<Value, String>) -> Value {
    let mut out = match result {
        Ok(Value::Object(extra)) => { let mut o = json!({ "ok": true }); for (k, v) in extra { o[k] = v; } o }
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    out["base"] = base_json(db, profile);
    out
}

pub async fn base(State(state): State<Arc<AppState>>, Query(params): Query<HashMap<String, String>>) -> Json<Value> {
    let user = match request_user(&state, params.get("token").map(String::as_str)) {
        Ok(u) => u,
        Err(e) => return e,
    };
    let db = state.db.clone();
    Json(tokio::task::spawn_blocking(move || match db.active_operator(&user) {
        Some(profile) => reply(&db, &profile, Ok(Value::Null)),
        None => json!({ "ok": false, "error": "Create an operator first." }),
    }).await.unwrap_or_default())
}

fn waves_of(body: &Value) -> Result<Option<[Counts; WAVES]>, String> {
    if body["waves"].is_null() { return Ok(None); }
    serde_json::from_value(body["waves"].clone()).map(Some).map_err(|_| "Waves must be three lists of soldiers".to_string())
}

fn layout_of(body: &Value) -> Result<Option<Layout>, String> {
    if body["layout"].is_null() { return Ok(None); }
    serde_json::from_value(body["layout"].clone()).map(Some).map_err(|_| "That layout can't be read".to_string())
}

fn entrances_of(body: &Value) -> Result<[u8; WAVES], String> {
    serde_json::from_value(body["entrances"].clone()).map_err(|_| "Pick entrance A, B or C for each wave".to_string())
}

pub async fn base_action(State(state): State<Arc<AppState>>, Path(action): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let user = match request_user(&state, body["token"].as_str()) {
        Ok(u) => u,
        Err(e) => return e,
    };
    let raiding = matches!(action.as_str(), "scout" | "raid");
    if raiding {
        if let Some(why) = auth::email_gate(&state, &user).await {
            return Json(json!({ "ok": false, "error": why.replace("to deploy", "to raid bases") }));
        }
    }
    let db = state.db.clone();
    Json(tokio::task::spawn_blocking(move || {
        let Some(profile) = db.active_operator(&user) else {
            return json!({ "ok": false, "error": "Create an operator first." });
        };
        let now = db::now_secs();
        let result = (|| -> Result<Value, String> {
            if raiding && !pvp_enabled() { return Err("Base raids are switched off on this server.".into()); }
            match action.as_str() {
                "save" => {
                    let (layout, waves) = (layout_of(&body)?, waves_of(&body)?);
                    if layout.is_none() && waves.is_none() { return Err("Nothing to save".into()); }
                    db.save_base(&profile, layout, waves).map(|spent| json!({ "spent": spent }))
                }
                "practice" => {
                    let waves = waves_of(&body)?.ok_or("Put at least one soldier in a wave.")?;
                    let plan = Plan { waves, entrances: entrances_of(&body)? };
                    db.practice_raid(&profile, layout_of(&body)?, &plan).map(|replay| json!({ "replay": replay }))
                }
                "scout" => db.scout_base(&profile, now).map(|(_, fee)| json!({ "fee": fee })),
                "raid" => db.launch_base_raid(&profile, entrances_of(&body)?, now)
                    .map(|report| json!({
                        "raid": {
                            "id": report.id, "defender": report.defender, "loot": report.loot,
                            "payout": report.payout, "contractBonus": report.contract_bonus, "salvage": report.salvage,
                        },
                        "replay": report.replay,
                    })),
                "replay" => db.base_replay(&profile, body["id"].as_str().unwrap_or("")).map(|replay| json!({ "replay": replay })),
                "refill" => db.refill_waves(&profile).map(|spent| json!({ "spent": spent })),
                "sell" => {
                    let kind = body["kind"].as_str().and_then(siege::Kind::parse).ok_or("Unknown piece or soldier")?;
                    let count = body["count"].as_u64().unwrap_or(1).min(9_999) as u32;
                    db.sell_base_spare(&profile, kind, count).map(|earned| json!({ "earned": earned }))
                }
                "ack" => db.ack_base_defenses(&profile, now).map(|_| Value::Null),
                _ => Err("Unknown action".into()),
            }
        })();
        reply(&db, &profile, result)
    }).await.unwrap_or_default())
}
