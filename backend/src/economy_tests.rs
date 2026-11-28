use super::*;
use crate::types::{RaidActivity, RaidResult};

fn outcome(result: RaidResult, kills: u32, crates: u32, loot: Vec<Item>) -> RaidOutcome {
    RaidOutcome { player_id: "p".into(), name: "P".into(), result, extract_name: None, killed_by: None,
        loot, lost: vec![], bounty: 0, kills, activity: RaidActivity { crates, ..Default::default() }, max_combo: 0, survived_secs: 0.0 }
}

fn setup() -> (Database, String, String) {
    let db=Database::open(":memory:").unwrap();
    let user=db.find_or_create_user("steam","mechanics","Mechanics","Mechanics").unwrap();
    let profile=db.create_operator(&user,"Tester",false,1_000).unwrap();
    (db,user,profile)
}

#[test]
fn empty_abandons_and_extractions_cannot_farm_xp_or_requisitions() {
    let (db,_,p)=setup();
    for slot in gear::SLOTS { db.unequip(&p,slot).unwrap(); }
    let cash=db.operator(&p).unwrap().cash;
    for result in [RaidResult::Abandoned,RaidResult::Extracted,RaidResult::Killed] {
        for _ in 0..6 {
            db.deploy(&p,"r",gear::default_map(),false).unwrap();
            let s=db.finish_raid_in(&p,Some("r"),&outcome(result.clone(),0,0,vec![])).unwrap();
            assert_eq!(s.ops.unwrap().xp,0); assert_eq!(s.cash,cash);
            assert_eq!(db.requisition_balance(&p,"outskirts"),0);
        }
    }
}

#[test]
fn activity_survives_loss_but_requisition_credits_require_extraction() {
    let (db,_,p)=setup();
    db.deploy(&p,"r",gear::default_map(),false).unwrap();
    let lost=outcome(RaidResult::Killed,10,2,vec![]);
    let s=db.finish_raid_in(&p,Some("r"),&lost).unwrap();
    assert_eq!(s.ops.unwrap().xp_gained,26);
    assert_eq!(db.requisition_balance(&p,"outskirts"),0);
    db.deploy(&p,"r",gear::default_map(),false).unwrap();
    let earned=outcome(RaidResult::Extracted,10,2,vec![]);
    let s=db.finish_raid_in(&p,Some("r"),&earned).unwrap();
    assert_eq!(s.ops.unwrap().xp_gained,52);
    assert_eq!(db.requisition_balance(&p,"outskirts"),26);
    assert!(db.finish_raid_in(&p,Some("r"),&earned).is_err());
    assert_eq!(db.requisition_balance(&p,"outskirts"),26);
}

#[test]
fn requisition_is_targeted_atomic_and_cannot_spend_another_maps_credits() {
    let (db,_,p)=setup();
    {
        let conn=db.conn.lock().unwrap();
        conn.execute("INSERT INTO operations (profile,map,xp,requisition) VALUES (?1,'outskirts',1000,120)",params![p]).unwrap();
        conn.execute("INSERT INTO facilities VALUES (?1,'armory',1)",params![p]).unwrap();
    }
    assert!(db.requisition(&p,&gear::MAPS[1],ItemKind::Pack).is_err());
    let gear=db.requisition(&p,gear::default_map(),ItemKind::Armor).unwrap();
    assert_eq!((gear.kind,gear.power,gear.rarity,gear.protected),(ItemKind::Armor,22,Rarity::Rare,true));
    assert_eq!(db.requisition_balance(&p,"outskirts"),0);
    assert!(db.requisition(&p,gear::default_map(),ItemKind::Armor).is_err());
    assert!(db.sell(&p,&gear.id).is_err());
    db.protect_item(&p,&gear.id,false).unwrap(); db.sell(&p,&gear.id).unwrap();
}

#[test]
fn protected_materials_and_installation_value_are_preserved() {
    let (db,_,p)=setup();
    let a=Item::new(ItemKind::Valuable,Rarity::Rare,40,None);
    let b=Item::new(ItemKind::Valuable,Rarity::Rare,20,None);
    {
        let conn=db.conn.lock().unwrap();
        conn.execute("UPDATE operators SET cash=20000 WHERE profile=?1",params![p]).unwrap();
        Database::insert_item(&conn,&p,&a,None).unwrap(); Database::insert_item(&conn,&p,&b,None).unwrap();
    }
    db.protect_item(&p,&a.id,true).unwrap();
    assert!(db.sell_many(&p,&[b.id.clone(),a.id.clone()]).is_err());
    assert!(db.operator(&p).unwrap().items.iter().any(|s| s.item.id==b.id),"bulk sale rolls back");
    assert!(db.upgrade_tier(&p).is_err());
    db.protect_item(&p,&a.id,false).unwrap();
    let value=db.operator_value(&p);
    db.upgrade_tier(&p).unwrap();
    assert_eq!(db.operator_value(&p),value,"consumed materials and cash become investment");
    db.upgrade_facility(&p,Facility::Storage,1_000).unwrap();
    assert_eq!(db.operator_value(&p),value,"facility purchases do not reduce retirement value");
}

#[test]
fn overflow_selection_is_atomic_owned_and_preserves_protected_loot() {
    let (db,_,p)=setup();
    db.deploy(&p,"r",gear::default_map(),false).unwrap();
    let loot=(0..gear::STASH_CAPACITY+2).map(|_|Item::new(ItemKind::Armor,Rarity::Rare,20,None)).collect();
    db.finish_raid(&p,&outcome(RaidResult::Extracted,1,0,loot)).unwrap();
    let op=db.operator(&p).unwrap();
    let pending:Vec<_>=op.items.iter().filter(|s| s.overflow).map(|s|s.item.id.clone()).collect();
    db.protect_item(&p,&pending[0],true).unwrap();
    assert!(db.resolve_overflow(&p,&pending,&[]).is_err());
    assert!(db.resolve_overflow(&p,&pending,&[pending[0].clone()]).is_err(),"stash full");
    let spare=op.items.iter().find(|s|s.slot.is_none()&&!s.overflow).unwrap(); db.sell(&p,&spare.item.id).unwrap();
    let before=db.operator(&p).unwrap().cash;
    db.resolve_overflow(&p,&pending,&[pending[0].clone()]).unwrap();
    let op=db.operator(&p).unwrap();
    assert!(op.items.iter().all(|s|!s.overflow));
    assert!(op.items.iter().any(|s|s.item.id==pending[0]&&s.item.protected));
    assert_eq!(op.cash-before,spare.item.value);
    assert!(db.resolve_overflow(&p,&pending,&[]).is_err());
}

#[test]
fn workshop_polling_preserves_fractional_production_and_caps_at_48_hours() {
    let (db,_,p)=setup();
    db.conn.lock().unwrap().execute("INSERT INTO facilities VALUES (?1,'workshop',1)",params![p]).unwrap();
    for now in 1_000..1_060 { assert_eq!(db.collect_workshop(&p,now).unwrap(),0); }
    assert_eq!(db.collect_workshop(&p,1_060).unwrap(),1);
    assert_eq!(db.collect_workshop(&p,1_061).unwrap(),0);
    assert_eq!(db.collect_workshop(&p,1_060+72*3600).unwrap(),48*60);
    assert_eq!(db.collect_workshop(&p,1_060+72*3600).unwrap(),0);
}

#[test]
fn respec_refunds_points_once_and_checks_every_operator_is_home() {
    let (db,user,p)=setup();
    {
        let conn=db.conn.lock().unwrap();
        conn.execute("UPDATE accounts SET legacy_earned=3 WHERE user_id=?1",params![user]).unwrap();
        conn.execute("UPDATE operators SET cash=2000 WHERE profile=?1",params![p]).unwrap();
    }
    db.buy_perk(&user,Perk::Vitality).unwrap();
    db.deploy(&p,"r",gear::default_map(),false).unwrap();
    assert!(db.respec(&user).is_err());
    db.void_raid(&p,"r",true);
    db.respec(&user).unwrap();
    assert_eq!(db.account_state(&user).legacy_available,3);
    assert_eq!(db.operator(&p).unwrap().cash,1000);
    assert!(db.respec(&user).is_err());
    assert_eq!(db.operator(&p).unwrap().cash,1000);
}

#[test]
fn pre_update_items_migrate_and_new_fields_survive_reopening() {
    let path=std::env::temp_dir().join(format!("boxhead-economy-migration-{}.db",uuid::Uuid::new_v4()));
    {
        let conn=Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE items (id TEXT PRIMARY KEY, profile TEXT NOT NULL, kind TEXT NOT NULL, rarity TEXT NOT NULL, power INTEGER NOT NULL, name TEXT NOT NULL, slot TEXT);
            INSERT INTO items VALUES ('legacy','p','encrypted','rare',55,'Legacy sealed loot',NULL);").unwrap();
    }
    {
        let db=Database::open(path.to_str().unwrap()).unwrap(); db.ensure_operator("p").unwrap();
        let item=db.operator("p").unwrap().items.into_iter().find(|s|s.item.id=="legacy").unwrap();
        assert_eq!((item.item.origin_tier,item.item.protected,item.overflow),(0,false,false));
        db.protect_item("p","legacy",true).unwrap();
        db.conn.lock().unwrap().execute("UPDATE items SET origin_tier=4,overflow=1 WHERE id='legacy'",[]).unwrap();
    }
    {
        let db=Database::open(path.to_str().unwrap()).unwrap();
        let item=db.operator("p").unwrap().items.into_iter().find(|s|s.item.id=="legacy").unwrap();
        assert_eq!((item.item.origin_tier,item.item.protected,item.overflow),(4,true,true));
    }
    let _=std::fs::remove_file(path);
}
