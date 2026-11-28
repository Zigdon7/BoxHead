use super::*;
use super::test_support::*;

fn arena(walls: Vec<Wall>) -> Game {
    let mut g = game();
    g.add_player("p", "P", &kit(5, 5, 5));
    g.clear_zombies();
    g.layout.walls = walls;
    g.layout.nests.clear();
    g.layout.extracts.clear();
    g.crates.clear();
    g.ammo_pickups.clear();
    g.wall_grid = build_wall_grid(&g.layout.walls, g.layout.width, g.layout.height);
    g.navigation = Navigation::new(g.layout.width, g.layout.height, &g.layout.walls);
    g.player_mut("p").pos = Vector2 { x: 200.0, y: 200.0 };
    g
}

#[test]
fn solid_walls_block_katana_but_open_space_does_not() {
    for blocked in [true, false] {
        let mut g = arena(if blocked { vec![Wall::new(220.0, 100.0, 20.0, 200.0)] } else { vec![] });
        g.push_zombie(enemy("z", ZombieType::Zombie, 255.0, 200.0, 1000.0, 0.0));
        let mut input = idle_input();
        input.mouse_x = 255.0; input.mouse_y = 200.0; input.melee = true;
        g.handle_input("p", input); g.update(1.0 / 60.0);
        assert_eq!(g.zombies[0].health == 1000.0, blocked);
    }
}

#[test]
fn solid_walls_block_revive_and_moving_to_the_same_side_restores_it() {
    let mut g = arena(vec![Wall::new(218.0, 100.0, 10.0, 200.0)]);
    g.add_player("q", "Q", &kit(5,5,5));
    g.player_mut("q").pos = Vector2 { x: 247.0, y: 200.0 };
    g.player_mut("p").health = 0.0; g.player_mut("p").bleedout = 25.0;
    for _ in 0..190 { g.update(1.0/60.0); }
    assert_eq!(g.players["p"].health, 0.0);
    assert!(g.players["p"].bleedout < 22.0, "a blocked rescuer cannot freeze bleedout");
    g.player_mut("q").pos = Vector2 { x: 200.0, y: 230.0 };
    for _ in 0..190 { g.update(1.0/60.0); }
    assert!(g.players["p"].health > 0.0);
    assert_eq!(g.players["q"].activity.revives, 0, "artificial downs without enemy damage do not pay");
}

#[test]
fn returning_monster_defends_locally_without_resetting_its_pursuit() {
    let mut g = arena(vec![]);
    let z = enemy("z", ZombieType::Zombie, 205.0, 200.0, 1000.0, 0.0);
    record_hit(&mut g.contributions, &z, "p", 20.0, 0.0);
    g.zombies.push(z);
    let mut brain = ZombieBrain { home: (205.0,200.0), ..ZombieBrain::default() };
    brain.return_home(); g.zombie_brains.insert("z".into(), brain);
    let health = g.players["p"].health;
    g.update(1.0/60.0);
    assert!(g.players["p"].health < health);
    assert!(g.zombie_brains["z"].returning && g.zombie_brains["z"].quarry.is_none());
    g.player_mut("p").pos.x = 600.0;
    g.update(1.0/60.0);
    assert!(g.zombie_brains["z"].quarry.is_none(), "defense cannot restart a long chase");
}

#[test]
fn hunter_origin_survives_expiry_and_never_grants_premium_loot() {
    let mut g = arena(vec![]);
    let mut z = enemy("z", ZombieType::Zombie, 255.0, 200.0, 1000.0, 0.0);
    z.elite = true; z.hunter = true; z.target = Some("p".into());
    g.zombies.push(z); g.boss_quarry.insert("z".into(), "p".into());
    g.zombie_brains.insert("z".into(), ZombieBrain { home: (255.0,200.0), hunt_elapsed: HUNTER_CHASE_SECS - 0.01, ..ZombieBrain::default() });
    g.update(0.02);
    assert!(g.zombies[0].hunter && g.zombies[0].target.is_none());
    assert_eq!(kill_bounty(&g.zombies[0], false), zombie_bounty(&ZombieType::Zombie));
    for kind in [ZombieType::Zombie, ZombieType::Abomination] {
        g.zombies[0].zombie_type = kind;
        let mut drops = Vec::new();
        for _ in 0..100 { Game::roll_kill_drops(g.map, &g.zombies[0], 0.0, &mut drops); }
        assert!(drops.iter().all(|d| d.item.is_none()), "pressure is not an equipment farm");
    }
}

#[test]
fn assist_rewards_split_one_pool_and_ignore_stale_or_trivial_tags() {
    let mut g = arena(vec![]);
    for id in ["q", "stale", "tag"] { g.add_player(id,id,&kit(5,5,5)); }
    let z = enemy("z",ZombieType::Zombie,300.0,200.0,100.0,0.0);
    g.game_time = 15.0;
    for (id, damage, time) in [("p",30.0,15.0),("q",60.0,15.0),("tag",1.0,15.0),("stale",50.0,0.0)] {
        record_hit(&mut g.contributions,&z,id,damage,time);
    }
    g.zombies.push(z);
    g.award_coop_kill("p","z",40.0);
    assert_eq!(g.players.values().map(|p| p.bounty).sum::<f64>(),40.0);
    assert_eq!(g.players["p"].kills,1);
    assert_eq!(g.players["q"].activity.assists,1);
    assert!(g.players["q"].bounty > g.players["p"].bounty);
    assert_eq!(g.players["tag"].bounty + g.players["stale"].bounty,0.0);
}

#[test]
fn hit_credit_caps_overkill_and_protection_toggle_is_consumed_once() {
    let mut g = arena(vec![]);
    let z = enemy("z",ZombieType::Zombie,250.0,200.0,10.0,0.0);
    record_hit(&mut g.contributions,&z,"p",500.0,0.0);
    assert_eq!(g.contributions["z"]["p"].0,10.0);
    let item = Item::new(ItemKind::Armor,gear::Rarity::Rare,20,None);
    let id = item.id.clone(); g.player_mut("p").backpack.push(item);
    let mut wire=serde_json::to_value(idle_input()).unwrap();
    wire["protectId"]=serde_json::json!(id);
    let input=serde_json::from_value(wire).unwrap(); g.handle_input("p",input);
    for _ in 0..5 { g.update(1.0/60.0); }
    assert!(g.players["p"].backpack[0].protected);
    let mut input=idle_input(); input.drop_id=Some(id); input.shooting=true; input.mouse_x=400.0; input.mouse_y=200.0;
    g.handle_input("p",input); g.update(1.0/60.0);
    assert_eq!(g.players["p"].backpack.len(),1);
    assert!(!g.bullets.is_empty(), "rejecting a protected drop must not suppress other actions");
    assert!(gear::swap_target(&g.players["p"].backpack,&Item::new(ItemKind::Pistol,gear::Rarity::Legendary,100,None)).is_none());
}

#[test]
fn lower_tier_decryption_preserves_base_item_but_not_rarity_upgrade() {
    use rand::{SeedableRng, rngs::StdRng};
    let mut item=Item::new(ItemKind::Encrypted,gear::Rarity::Rare,65,None);
    item.origin_tier=4; item.protected=true;
    let mut rng=StdRng::seed_from_u64(42);
    let mut upgrades=0;
    for _ in 0..200 {
        let safe=gear::decrypt_at(&mut rng,&item,1);
        assert_eq!((safe.rarity,safe.power,safe.origin_tier,safe.protected),(item.rarity,65,4,true));
        let risky=gear::decrypt_at(&mut rng,&item,4);
        if risky.rarity > item.rarity { upgrades+=1; }
    }
    assert!(upgrades>0);
}
